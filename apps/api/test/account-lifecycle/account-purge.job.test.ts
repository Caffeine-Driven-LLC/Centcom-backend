/**
 * The account purge on Postgres 16 (B026; tests "account-purge.job.test.ts"; DATABASE_URL, CI's
 * integration job), with a fake clock moved past the 30-day deadline:
 *
 * - a full purge deletes the user row, devices, tokens, memberships, API keys, notifications,
 *   preferences and exports (and the export files); audit rows keep their `aud_` ids with the user
 *   replaced by `usr_deleted`; a second run is a no-op (acceptance 7);
 * - a workspace the user was alone in is deleted the way its owner would, and the purge waits for
 *   it (acceptance 3);
 * - a deletion cancelled before the deadline is not carried out (acceptance 8);
 * - a user other people's records still point at keeps a scrubbed row; a user who became the only
 *   owner of a shared workspace is not purged at all.
 */
import { newId } from '@centcom/contracts';
import { createAuditEmitter, type AuditDb } from '@centcom/core';
import { createWorkspaceStore, type CoreDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_LIFECYCLE_ACTIONS,
  createAccountLifecycleStore,
  DELETED_USER_NAME,
  duePurges,
  purgeUser,
  scrubbedEmail,
  type LifecycleDb,
  type PurgeDb,
  type PurgeDeps,
} from '../../src/modules/account-lifecycle/index.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import { memoryBlobStore } from './helpers.js';
import { seedPersonalData } from './postgres.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe.runIf(ADMIN_URL !== undefined)('account-purge on Postgres 16', () => {
  let test: TestDatabase;
  let db: Kysely<PurgeDb>;
  let core: Kysely<CoreDatabase>;

  beforeAll(async () => {
    test = await migratedDatabase(10);
    core = test.db;
    db = test.db as unknown as Kysely<PurgeDb>;
  });
  afterAll(async () => {
    await test?.drop();
  });

  /** Purge deps with a clock `days` after now, a recording blob store and workspace deleter. */
  function purgeDeps(clock: { now: number }) {
    const blobs = memoryBlobStore();
    const deletedWorkspaces: string[] = [];
    const deps: PurgeDeps = {
      db,
      blobs: blobs.store,
      emitter: createAuditEmitter({
        db: db as unknown as AuditDb,
        actions: ACCOUNT_LIFECYCLE_ACTIONS,
      }),
      deleteWorkspace: async (workspaceId) => {
        deletedWorkspaces.push(workspaceId);
        await db
          .updateTable('workspaces')
          .set({ deleted_at: new Date(clock.now) })
          .where('id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .execute();
      },
      clock: () => clock.now,
    };
    return { deps, blobs, deletedWorkspaces };
  }

  /** Schedules the deletion of `userId` at `now`. */
  async function schedule(userId: string, now: number): Promise<void> {
    const store = createAccountLifecycleStore(db as unknown as Kysely<LifecycleDb>);
    const outcome = await store.scheduleDeletion(
      userId,
      new Date(now),
      new Date(now + 30 * DAY_MS),
      () => Promise.resolve(),
    );
    expect(outcome.kind).toBe('scheduled');
  }

  const count = async (table: keyof PurgeDb, column: string, value: string): Promise<number> => {
    const row = await sql<{ n: string }>`
      select count(*) as n from ${sql.table(table)} where ${sql.ref(column)} = ${value}
    `.execute(db);
    return Number(row.rows[0]?.n ?? 0);
  };

  it('purges everything of the user after the deadline, and only once (acceptance 7, 3)', async () => {
    const clock = { now: Date.now() };
    const userId = await pgUser(core);
    const teammate = await pgUser(core);
    // A team the user is a member of, and their personal workspace (they are alone in it).
    const team = await pgWorkspace(core, teammate);
    await pgJoin(core, team, teammate, 'owner');
    await pgJoin(core, team, userId, 'member');
    const seeded = await seedPersonalData(db as unknown as Kysely<LifecycleDb>, userId);
    await seedPersonalData(db as unknown as Kysely<LifecycleDb>, teammate, team);
    const exportId = newId('exp');
    await db
      .insertInto('account_exports')
      .values({
        id: exportId,
        user_id: userId,
        status: 'ready',
        blob_key: `exports/${userId}/${exportId}.json`,
      })
      .execute();
    const auditIds = (
      await db
        .selectFrom('audit_events')
        .select('id')
        .where((eb) => eb.or([eb('actor_id', '=', userId), eb('target_id', '=', userId)]))
        .execute()
    ).map((r) => r.id);
    expect(auditIds).toHaveLength(2);
    await schedule(userId, clock.now);
    const { deps, blobs, deletedWorkspaces } = purgeDeps(clock);

    // Before the deadline nothing happens.
    clock.now += 29 * DAY_MS;
    expect(await purgeUser(deps, userId)).toBe('not_due');
    expect(await duePurges(db, new Date(clock.now), 10)).not.toContain(userId);

    clock.now += 1 * DAY_MS + 1000;
    expect(await duePurges(db, new Date(clock.now), 10)).toContain(userId);
    // The personal workspace is deleted as its owner would; the purge waits for it.
    expect(await purgeUser(deps, userId)).toBe('waiting');
    expect(deletedWorkspaces).toEqual([seeded.workspaceId]);
    expect(blobs.state.deletes).toEqual([`exports/${userId}/${exportId}.json`]);
    const scrubbed = await db
      .selectFrom('users')
      .select(['email', 'display_name', 'avatar_slot', 'status', 'deleted_at'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(scrubbed).toMatchObject({
      email: scrubbedEmail(userId),
      display_name: DELETED_USER_NAME,
      avatar_slot: null,
      status: 'deleted',
    });
    // The team keeps going without them.
    expect(await count('memberships', 'workspace_id', team)).toBe(2 - 1);

    // B027's workspace purge job runs; then the purge finishes.
    await createWorkspaceStore(core).purge(seeded.workspaceId);
    expect(await purgeUser(deps, userId)).toBe('deleted');

    expect(await count('users', 'id', userId)).toBe(0);
    for (const [table, column] of [
      ['devices', 'user_id'],
      ['refresh_tokens', 'user_id'],
      ['memberships', 'user_id'],
      ['api_keys', 'created_by'],
      ['notifications', 'user_id'],
      ['notification_pref', 'user_id'],
      ['push_subscriptions', 'user_id'],
      ['identities', 'user_id'],
      ['account_exports', 'user_id'],
    ] as const) {
      expect(await count(table, column, userId), table).toBe(0);
    }
    // The teammate's data is untouched.
    expect(await count('devices', 'user_id', teammate)).toBe(1);
    expect(await count('api_keys', 'created_by', teammate)).toBe(1);

    // Audit rows keep their ids; the user's id is gone from them.
    const audit = await db
      .selectFrom('audit_events')
      .select(['id', 'actor_id', 'target_id'])
      .where('id', 'in', auditIds)
      .orderBy('id')
      .execute();
    expect(audit.map((r) => r.id).sort()).toEqual([...auditIds].sort());
    expect(JSON.stringify(audit)).not.toContain(userId);
    expect(audit.some((r) => r.actor_id === 'usr_deleted')).toBe(true);
    expect(audit.some((r) => r.target_id === 'usr_deleted')).toBe(true);
    const purges = await db
      .selectFrom('audit_events')
      .select(['actor_id', 'meta'])
      .where('action', '=', 'account.purge')
      .execute();
    expect(purges.map((p) => p.meta)).toEqual(
      expect.arrayContaining([{ outcome: 'scrubbed' }, { outcome: 'deleted' }]),
    );

    // Running it again is a no-op.
    expect(await purgeUser(deps, userId)).toBe('gone');
  });

  it('does nothing when the deletion was cancelled before the deadline (acceptance 8)', async () => {
    const clock = { now: Date.now() };
    const userId = await pgUser(core);
    await seedPersonalData(db as unknown as Kysely<LifecycleDb>, userId);
    await schedule(userId, clock.now);
    const store = createAccountLifecycleStore(db as unknown as Kysely<LifecycleDb>);
    expect(await store.cancelDeletion(userId)).toBe(true);
    const { deps, deletedWorkspaces } = purgeDeps(clock);
    clock.now += 31 * DAY_MS;
    expect(await purgeUser(deps, userId)).toBe('cancelled');
    expect(deletedWorkspaces).toEqual([]);
    expect(await count('users', 'id', userId)).toBe(1);
    expect(await count('notifications', 'user_id', userId)).toBe(1);
    expect(await count('api_keys', 'created_by', userId)).toBe(1);
  });

  it('keeps a scrubbed row while other people’s records point at the user', async () => {
    const clock = { now: Date.now() };
    const userId = await pgUser(core);
    const heir = await pgUser(core);
    // The user created the team, then handed it over and stayed as a member.
    const team = await pgWorkspace(core, userId);
    await pgJoin(core, team, heir, 'owner');
    await pgJoin(core, team, userId, 'member');
    await schedule(userId, clock.now);
    const { deps } = purgeDeps(clock);
    clock.now += 31 * DAY_MS;
    expect(await purgeUser(deps, userId)).toBe('scrubbed');
    const row = await db
      .selectFrom('users')
      .select(['email', 'display_name', 'status'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      email: scrubbedEmail(userId),
      display_name: DELETED_USER_NAME,
      status: 'deleted',
    });
    expect(await count('memberships', 'user_id', userId)).toBe(0);
    expect(await count('workspaces', 'id', team)).toBe(1);
    // Again: still scrubbed, nothing else happens.
    expect(await purgeUser(deps, userId)).toBe('scrubbed');
  });

  it('does not purge a user who became the only owner of a shared workspace', async () => {
    const clock = { now: Date.now() };
    const userId = await pgUser(core);
    await schedule(userId, clock.now);
    // During the grace period someone joins the user's workspace.
    const team = await pgWorkspace(core, userId);
    await pgJoin(core, team, userId, 'owner');
    await pgJoin(core, team, await pgUser(core), 'member');
    const { deps } = purgeDeps(clock);
    clock.now += 31 * DAY_MS;
    expect(await purgeUser(deps, userId)).toBe('blocked');
    const row = await db
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending_deletion');
  });

  it('answers gone for an unknown user', async () => {
    const { deps } = purgeDeps({ now: Date.now() });
    expect(await purgeUser(deps, newId('usr'))).toBe('gone');
  });
});
