/**
 * Account deletion through the real API process pieces (B026; Postgres, DATABASE_URL): the routes are
 * registered by `buildApp`, a deletion revokes the caller's tokens at once, a second request keeps the first
 * deadline, the only owner of a shared workspace is refused, a user in the grace period can sign in again and
 * restore, and the worker's purge (the same `createJobServices` the worker process builds, the
 * `account-purge` processor and the hourly sweep) removes the account after the deadline: personal rows gone,
 * audit rows pseudonymised, the sole workspace deleted through the workspace purge, a second run a no-op.
 * Without an object store the export routes are left out and the purge counts that it wrote no tombstone.
 */
import { createMemoryRedis } from '@centcom/core';
import { createWorkspaceStore } from '@centcom/db';
import { createFactories } from '@centcom/testkit';
import { processAccountPurge, processWorkspacePurge } from '@centcom/worker';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase } from '../../src/context.js';
import { createJobServices } from '../../src/jobs.js';
import { SCOPES } from '../../src/modules/auth/tokens/service.js';
import { DELETED_USER_ID } from '../../src/modules/account-lifecycle/index.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../modules/users/helpers.js';
import { testEnv } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe.runIf(ADMIN_URL !== undefined)('account deletion on Postgres, through the API', () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let ctx: ReturnType<typeof createContext>;
  let db: Kysely<ApiDatabase>;
  let any: Kysely<Record<string, Record<string, unknown>>>;
  const redis = createMemoryRedis();
  const metrics = recordingMetrics();
  let adaId = '';
  let adaWorkspace = '';
  let bobId = '';
  let teamWorkspace = '';

  const as = async (userId: string, deviceId: string): Promise<string> => {
    const issued = await ctx.tokens.issueTokens({
      userId,
      deviceId,
      scopes: SCOPES.filter((s) => s !== 'admin'),
    });
    return `Bearer ${issued.access_token}`;
  };
  const call = (method: 'GET' | 'DELETE' | 'POST', url: string, authorization: string) =>
    app.inject({ method, url, headers: { authorization } });
  const row = async () =>
    any
      .selectFrom('users')
      .select(['status', 'deletion_scheduled_at', 'deleted_at', 'email'])
      .where('id', '=', adaId)
      .executeTakeFirst();

  beforeAll(async () => {
    database = await migratedDatabase(10);
    db = database.db as unknown as Kysely<ApiDatabase>;
    any = database.db as unknown as typeof any;
    const factories = createFactories(database.db);
    const ada = await factories.users.create();
    const bob = await factories.users.create();
    const carol = await factories.users.create();
    adaId = ada.id;
    bobId = bob.id;
    adaWorkspace = (await factories.workspaces.create({ owner: ada })).id;
    teamWorkspace = (await factories.workspaces.create({ owner: bob })).id;
    await factories.memberships.create({ workspace: teamWorkspace, user: carol, role: 'member' });
    const config = loadApiConfig(
      testEnv({ RATELIMIT_AUTH_LIMIT: '1000', RATELIMIT_ANONYMOUS_LIMIT: '1000' }),
    );
    const deps = { config, db, redis, logger: captureLogger().logger, metrics: metrics.metrics };
    ctx = createContext(deps);
    app = await buildApp(deps);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('registers the deletion routes, and leaves the export routes out without an object store', () => {
    expect(app.hasRoute({ method: 'DELETE', url: '/v1/me' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/v1/me/restore' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/v1/me/export' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/v1/me/export/:id' })).toBe(false);
  });

  it('refuses without a token, and the only owner of a workspace that has other members', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/v1/me' })).statusCode).toBe(401);
    const bobDevice = await createFactories(database.db).devices.create({ user: bobId });
    const res = await call('DELETE', '/v1/me', await as(bobId, bobDevice.id));
    expect(res.statusCode, res.body).toBe(409);
    const stored = await any
      .selectFrom('users')
      .select(['status', 'deletion_scheduled_at'])
      .where('id', '=', bobId)
      .executeTakeFirst();
    expect(stored).toEqual({ status: 'active', deletion_scheduled_at: null });
  });

  let firstDeadline = '';
  it('schedules the deletion once and revokes the caller at once', async () => {
    const device = await createFactories(database.db).devices.create({ user: adaId });
    const token = await as(adaId, device.id);
    expect((await call('GET', '/v1/me', token)).statusCode).toBe(200);
    const before = Date.now();
    const res = await call('DELETE', '/v1/me', token);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.headers['location']).toBe('/v1/me');
    const body = res.json<{ status: string; scheduled_for: string; grace_days: number }>();
    expect(body).toMatchObject({ status: 'pending_deletion', grace_days: 30 });
    firstDeadline = body.scheduled_for;
    expect(Math.abs(Date.parse(firstDeadline) - (before + 30 * DAY_MS))).toBeLessThan(5_000);
    expect((await row())?.status).toBe('pending_deletion');
    // The token handed out before the deletion is dead on the next request.
    const after = await call('GET', '/v1/me', token);
    expect(after.statusCode).toBe(401);
    const refresh = await any
      .selectFrom('refresh_tokens')
      .select('revoked_at')
      .where('user_id', '=', adaId)
      .execute();
    for (const t of refresh) expect(t['revoked_at']).not.toBeNull();
    expect(metrics.count('account_deletions_requested_total')).toBe(1);
  });

  it('keeps the first deadline when the deletion is requested again, after signing in during the grace period', async () => {
    const device = await createFactories(database.db).devices.create({ user: adaId });
    // revokeUser flags the user at the second; a token issued later in the same second would be dead too.
    await new Promise((r) => setTimeout(r, 1_100));
    const token = await as(adaId, device.id);
    const me = await call('GET', '/v1/me', token);
    expect(me.statusCode, me.body).toBe(200);
    expect(
      me.json<{ user: { deletion_scheduled_for?: string } }>().user.deletion_scheduled_for,
    ).toBe(firstDeadline);
    const again = await call('DELETE', '/v1/me', token);
    expect(again.statusCode).toBe(202);
    expect(again.json<{ scheduled_for: string }>().scheduled_for).toBe(firstDeadline);
  });

  it('restores within the grace period (once), and a restored account is not purged', async () => {
    await new Promise((r) => setTimeout(r, 1_100));
    const device = await createFactories(database.db).devices.create({ user: adaId });
    const token = await as(adaId, device.id);
    const restored = await call('POST', '/v1/me/restore', token);
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await row())?.status).toBe('active');
    expect((await call('POST', '/v1/me/restore', token)).statusCode).toBe(409);
    // A purge that fires anyway finds nothing due.
    const jobs = createJobServices(workerContext(Date.now() + 31 * DAY_MS));
    expect(await jobs.accounts.purge(adaId)).toBe('cancelled');
    expect((await row())?.status).toBe('active');
  });

  /** The context the worker process builds, 31 days from now, with workspace purges kept in memory. */
  const queued: { workspaceId: string }[] = [];
  function workerContext(at: number) {
    return createContext({
      config: ctx.config,
      db,
      redis,
      logger: captureLogger().logger,
      metrics: metrics.metrics,
      clock: () => at,
      purgeQueue: {
        add: (_name, data) => {
          queued.push({ workspaceId: data.workspaceId });
          return Promise.resolve();
        },
      },
    });
  }

  it('purges the account after the deadline: personal rows, audit pseudonymised, sole workspace deleted', async () => {
    await new Promise((r) => setTimeout(r, 1_100));
    const device = await createFactories(database.db).devices.create({ user: adaId });
    const token = await as(adaId, device.id);
    expect((await call('DELETE', '/v1/me', token)).statusCode).toBe(202);
    await any
      .insertInto('notifications')
      .values({
        id: `ntf_${'0'.repeat(25)}1`,
        user_id: adaId,
        event_id: 'evt-1',
        category: 'mention',
        priority: 'normal',
        channels: ['inbox'],
        params: JSON.stringify({}),
        digest_pending: false,
      })
      .execute();

    const workerCtx = workerContext(Date.now() + 31 * DAY_MS);
    const jobs = createJobServices(workerCtx);
    // The hourly sweep queues the due user; a purge that has to wait is retried by BullMQ.
    const added: string[] = [];
    const sweep = await processAccountPurge(
      { id: 's', name: 'sweep', data: {}, attemptsMade: 0 },
      {
        purge: (id) => jobs.accounts.purge(id),
        due: (now, limit) => jobs.accounts.due(now, limit),
        clock: () => Date.now() + 31 * DAY_MS,
      },
      {
        add: (_name: string, data: unknown) => {
          added.push((data as { userId: string }).userId);
          return Promise.resolve({} as never);
        },
      },
    );
    expect(sweep).toBe('swept');
    expect(added).toEqual([adaId]);

    expect(await jobs.accounts.purge(adaId)).toBe('waiting'); // her workspace is being purged
    expect(queued.map((q) => q.workspaceId)).toEqual([adaWorkspace]);
    await processWorkspacePurge(
      { id: adaWorkspace, data: { workspaceId: adaWorkspace }, attemptsMade: 0 },
      {
        hooks: jobs.hooks,
        store: createWorkspaceStore(database.db),
        events: redis.pubsub,
      },
    );
    expect(await jobs.accounts.purge(adaId)).toBe('deleted');
    expect(await row()).toBeUndefined();
    for (const [table, column] of [
      ['memberships', 'user_id'],
      ['devices', 'user_id'],
      ['refresh_tokens', 'user_id'],
      ['notifications', 'user_id'],
      ['api_keys', 'created_by'],
    ] as const) {
      const left = await any.selectFrom(table).select(column).where(column, '=', adaId).execute();
      expect(left, table).toEqual([]);
    }
    const audits = await sql<{ n: string }>`
      select count(*) as n from audit_events where actor_id = ${adaId} or target_id = ${adaId}`.execute(
      database.db,
    );
    expect(audits.rows[0]?.n).toBe('0');
    const pseudonymised = await sql<{ n: string }>`
      select count(*) as n from audit_events
      where actor_id = ${DELETED_USER_ID} and action = 'account.delete_request'`.execute(
      database.db,
    );
    expect(Number(pseudonymised.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    const purgeEvents = await sql<{ n: string }>`
      select count(*) as n from audit_events where action = 'account.purge'`.execute(database.db);
    expect(purgeEvents.rows[0]?.n).toBe('2'); // one when the data is scrubbed, one when the row goes
    expect(await jobs.accounts.purge(adaId)).toBe('gone'); // a second run does nothing
    // No object store in this test: the purge ran without a tombstone and counted that.
    expect(metrics.count('account_tombstones_skipped_total')).toBeGreaterThanOrEqual(1);
    // Nobody else was touched.
    expect(
      (await any.selectFrom('users').select('status').where('id', '=', bobId).execute())[0],
    ).toEqual({ status: 'active' });
  });
});
