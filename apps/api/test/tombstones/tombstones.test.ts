/**
 * The deletion tombstone log: the purge hook records a purged workspace first, outside the database; after a
 * restore from an older backup the log deletes the resurrected workspace again and touches nothing else; a
 * second run does nothing; a dry run changes nothing; objects that are not tombstones are counted and ignored.
 */
import { createMemoryRedis } from '@centcom/core';
import { createWorkspaceStore } from '@centcom/db';
import { createMemoryBlobStore } from '@centcom/storage';
import { createFactories } from '@centcom/testkit';
import { createPurgeHookRegistry, processWorkspacePurge } from '@centcom/worker';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@centcom/contracts';
import { createAuditEmitter, noopMetrics, type AuditDb } from '@centcom/core';
import { sql } from 'kysely';
import {
  ACCOUNT_LIFECYCLE_ACTIONS,
  createAccountLifecycleStore,
  purgeUser,
  scrubbedEmail,
  type PurgeDb,
} from '../../src/modules/account-lifecycle/index.js';
import {
  accountTombstoneKey,
  applyTombstones,
  blobTombstoneLog,
  registerTombstoneHook,
  TOMBSTONE_HOOK,
  tombstoneKey,
} from '../../src/modules/tombstones/index.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../modules/users/helpers.js';

describe('the log', () => {
  it('writes an opaque id and a time, reads them back, and counts what is not a tombstone', async () => {
    const blobs = createMemoryBlobStore();
    const log = blobTombstoneLog(blobs);
    const id = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    await log.record({ kind: 'workspace', id, deletedAt: new Date('2026-10-14T10:00:00Z') });
    await log.record({ kind: 'workspace', id, deletedAt: new Date('2026-10-14T10:00:00Z') }); // idempotent
    const body = new TextDecoder().decode(await blobs.get(tombstoneKey(id)));
    expect(JSON.parse(body)).toEqual({
      v: 1,
      kind: 'workspace',
      id,
      deleted_at: '2026-10-14T10:00:00.000Z',
    });
    await blobs.put(
      'tombstones/workspace/wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4X.json',
      new TextEncoder().encode('not json'),
    );
    await blobs.put('tombstones/workspace/other.txt', new TextEncoder().encode('{}'));
    const { tombstones, unreadable } = await log.list();
    expect(tombstones).toEqual([
      { kind: 'workspace', id, deletedAt: new Date('2026-10-14T10:00:00Z') },
    ]);
    expect(unreadable).toBe(2);
  });

  it('records an account the same way, in its own folder, and lists both kinds', async () => {
    const blobs = createMemoryBlobStore();
    const log = blobTombstoneLog(blobs);
    const usr = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    const wsp = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    const at = new Date('2026-10-14T10:00:00Z');
    await log.record({ kind: 'account', id: usr, deletedAt: at });
    await log.record({ kind: 'workspace', id: wsp, deletedAt: at });
    expect(JSON.parse(new TextDecoder().decode(await blobs.get(accountTombstoneKey(usr))))).toEqual(
      {
        v: 1,
        kind: 'account',
        id: usr,
        deleted_at: '2026-10-14T10:00:00.000Z',
      },
    );
    // A tombstone whose kind does not match its folder is not trusted.
    await blobs.put(
      'tombstones/account/usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X.json',
      new TextEncoder().encode(
        '{"v":1,"kind":"workspace","id":"usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X","deleted_at":"2026-10-14T10:00:00Z"}',
      ),
    );
    const { tombstones, unreadable } = await log.list();
    expect(tombstones.map((t) => `${t.kind}:${t.id}`).sort()).toEqual([
      `account:${usr}`,
      `workspace:${wsp}`,
    ]);
    expect(unreadable).toBe(1);
    expect(() => accountTombstoneKey(wsp)).toThrow(TypeError);
  });

  it('refuses a key built from anything but a workspace id', () => {
    expect(() => tombstoneKey('../etc/passwd')).toThrow(TypeError);
  });

  it('registers as the first purge hook when asked first', () => {
    const registry = createPurgeHookRegistry();
    registerTombstoneHook(registry, blobTombstoneLog(createMemoryBlobStore()));
    registry.register('later', () => Promise.resolve());
    expect(registry.list().map((h) => h.name)).toEqual([TOMBSTONE_HOOK, 'later']);
  });
});

describe.runIf(ADMIN_URL !== undefined)('after a restore, on Postgres', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await migratedDatabase(10);
  });
  afterAll(async () => {
    await database.drop();
  });

  it('deletes again a workspace that was purged after the backup, and nothing else', async () => {
    const db = database.db;
    const factories = createFactories(db);
    const owner = await factories.users.create();
    const purged = await factories.workspaces.create({ owner });
    const kept = await factories.workspaces.create({ owner });
    const blobs = createMemoryBlobStore();
    const log = blobTombstoneLog(blobs);
    const hooks = createPurgeHookRegistry();
    registerTombstoneHook(hooks, log);
    const store = createWorkspaceStore(db);
    const events = createMemoryRedis().pubsub;
    const purge = (workspaceId: string) =>
      processWorkspacePurge(
        { id: workspaceId, data: { workspaceId }, attemptsMade: 0 },
        { hooks, store, events },
      );
    const sqlDb = db as unknown as Kysely<{
      workspaces: { id: string; deleted_at: Date | null };
      users: { id: string; status: string; deletion_scheduled_at: Date | null };
    }>;

    // The customer deletes a workspace: soft delete, then the purge job (its first hook writes the tombstone).
    await sqlDb
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', purged.id)
      .execute();
    expect((await purge(purged.id)).purged).toBe(true);
    expect((await log.list()).tombstones.map((t) => t.id)).toEqual([purged.id]);
    expect(
      await sqlDb.selectFrom('workspaces').select('id').where('id', '=', purged.id).execute(),
    ).toEqual([]);

    // The disaster: a backup from before the deletion is restored, so the workspace is back, live.
    await (db as unknown as Kysely<{ workspaces: Record<string, unknown> }>)
      .insertInto('workspaces')
      .values({
        id: purged.id,
        name: purged.name,
        slug: `${purged.slug}-restored`,
        created_by: owner.id,
      })
      .execute();
    const dry = await applyTombstones({ db: sqlDb, log, purge, dryRun: true });
    expect(dry).toMatchObject({ tombstones: 1, wouldPurge: [purged.id], purged: [] });
    expect(
      await sqlDb
        .selectFrom('workspaces')
        .select('deleted_at')
        .where('id', '=', purged.id)
        .executeTakeFirst(),
    ).toEqual({ deleted_at: null });

    const applied = await applyTombstones({ db: sqlDb, log, purge });
    expect(applied).toMatchObject({ tombstones: 1, purged: [purged.id], absent: 0 });
    const left = await sqlDb
      .selectFrom('workspaces')
      .select('id')
      .where('id', 'in', [purged.id, kept.id])
      .execute();
    expect(left.map((r) => r.id)).toEqual([kept.id]);

    const again = await applyTombstones({ db: sqlDb, log, purge });
    expect(again).toMatchObject({ purged: [], absent: 1 });
  });
});

describe.runIf(ADMIN_URL !== undefined)('a restore does not resurrect a deleted account', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await migratedDatabase(10);
  });
  afterAll(async () => {
    await database.drop();
  });

  it('writes the tombstone before the purge destroys anything, and purges the restored account again', async () => {
    const factories = createFactories(database.db);
    const gone = await factories.users.create();
    const kept = await factories.users.create();
    const blobs = createMemoryBlobStore();
    const log = blobTombstoneLog(blobs);
    const purgeDb = database.db as unknown as Kysely<PurgeDb>;
    const emitter = createAuditEmitter({
      db: database.db as unknown as AuditDb,
      actions: ACCOUNT_LIFECYCLE_ACTIONS,
    });
    const clock = { now: Date.now() };
    const deps = (tombstones = log) => ({
      db: purgeDb,
      blobs: { delete: () => Promise.resolve() },
      deleteWorkspace: () => Promise.resolve(),
      emitter,
      tombstones,
      clock: () => clock.now,
      metrics: noopMetrics,
    });

    // The account asks for deletion; the grace period ends; the purge's first act is the tombstone.
    const store = createAccountLifecycleStore(database.db as never);
    await store.scheduleDeletion(gone.id, new Date(), new Date(Date.now() + 1000), () =>
      Promise.resolve(),
    );
    clock.now = Date.now() + 60_000;
    // A tombstone log that fails stops the purge before any data is touched.
    const failing = { record: () => Promise.reject(new Error('object store down')) };
    await expect(purgeUser(deps(failing as never), gone.id)).rejects.toThrow('object store down');
    const intact = await sql<{ status: string; email: string }>`
      select status, email::text as email from users where id = ${gone.id}`.execute(database.db);
    expect(intact.rows[0]?.status).toBe('pending_deletion');
    expect(intact.rows[0]?.email).not.toBe(scrubbedEmail(gone.id));

    const outcome = await purgeUser(deps(), gone.id);
    expect(['deleted', 'scrubbed']).toContain(outcome);
    expect((await log.list()).tombstones.map((t) => `${t.kind}:${t.id}`)).toEqual([
      `account:${gone.id}`,
    ]);

    // The disaster: a backup from before the deletion comes back; the account is live again.
    await sql`delete from users where id = ${gone.id} and status = 'deleted'`
      .execute(database.db)
      .catch(() => undefined);
    await sql`
      insert into users (id, email, display_name, status)
      values (${gone.id}, ${`back+${gone.id}@example.test`}, 'Back again', 'active')
      on conflict (id) do update
        set email = excluded.email, display_name = excluded.display_name, status = 'active',
            deleted_at = null, deletion_scheduled_at = null`.execute(database.db);
    const sqlDb = database.db as unknown as Kysely<{
      workspaces: { id: string; deleted_at: Date | null };
      users: { id: string; status: string; deletion_scheduled_at: Date | null };
    }>;
    const noWorkspaces = () => Promise.resolve({ purged: false });
    const purgeAccount = (id: string) => purgeUser(deps(), id);

    const dry = await applyTombstones({
      db: sqlDb,
      log,
      purge: noWorkspaces,
      purgeAccount,
      dryRun: true,
    });
    expect(dry).toMatchObject({ accountsWouldPurge: [gone.id], accountsPurged: [] });
    expect(
      (
        await sql<{ status: string }>`select status from users where id = ${gone.id}`.execute(
          database.db,
        )
      ).rows[0]?.status,
    ).toBe('active');

    const applied = await applyTombstones({ db: sqlDb, log, purge: noWorkspaces, purgeAccount });
    expect(applied.accountsPurged).toEqual([gone.id]);
    const after = await sql<{ status: string; email: string }>`
      select status, email::text as email from users where id in (${gone.id})`.execute(database.db);
    // Either the row is gone or it is the scrubbed shell: never the live account.
    for (const r of after.rows) {
      expect(r.status).toBe('deleted');
      expect(r.email).toBe(scrubbedEmail(gone.id));
    }
    const again = await applyTombstones({ db: sqlDb, log, purge: noWorkspaces, purgeAccount });
    expect(again.accountsPurged).toEqual([]);
    // The other user was never touched.
    expect(
      (
        await sql<{ status: string }>`select status from users where id = ${kept.id}`.execute(
          database.db,
        )
      ).rows[0]?.status,
    ).toBe('active');
    expect(newId('usr')).toMatch(/^usr_/);
  });
});
