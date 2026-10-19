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
import {
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
    const sqlDb = db as unknown as Kysely<{ workspaces: { id: string; deleted_at: Date | null } }>;

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
