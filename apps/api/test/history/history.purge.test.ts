/**
 * Purging history (B055; tests "history.purge.test.ts") on Postgres 16 (DATABASE_URL):
 *
 * - DELETE as an editor is 403; as the host 204, then GET returns an empty page, the blob store
 *   lists no key for the session and one audit event is written (acceptance 4);
 * - blobs go before their index rows, so a purge that fails partway leaves only frames whose blob
 *   is still there, reads see only those, and a retry finishes the purge (failure mode);
 * - an orphan blob (written, never indexed) is purged too; retention metadata goes with the rows;
 * - other sessions are untouched.
 */
import type { HistoryDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceStore } from '@centcom/db';
import {
  createHistoryStore,
  createWorkspaceHistoryPurger,
  createMemoryBlobStore,
  encodeBatch,
  historyBlobKey,
  historyPrefix,
  retentionExpiry,
} from '../../src/modules/history/index.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import { historyApp, scriptedAccess, storedRange } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('history purge on Postgres 16', () => {
  let test: TestDatabase;
  let db: Kysely<HistoryDatabase>;

  beforeAll(async () => {
    test = await migratedDatabase(10);
    db = test.db as unknown as Kysely<HistoryDatabase>;
  });
  afterAll(async () => {
    await test?.drop();
  });

  async function newSession(): Promise<string> {
    const owner = await pgUser(test.db);
    return pgSession(test.db, await pgWorkspace(test.db, owner), owner);
  }

  it('lets the host purge, not an editor; leaves nothing behind (acceptance 4)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    const other = await newSession();
    await store.append(sid, storedRange(sid, 1, 300));
    await store.append(sid, storedRange(sid, 301, 450));
    await store.append(other, storedRange(other, 1, 10));
    await store.setExpiry(sid, retentionExpiry(new Date(), 7));
    const scripted = scriptedAccess();
    const host = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4A';
    const editor = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4B';
    scripted.set(sid, host, { role: 'host' });
    scripted.set(sid, editor, { role: 'editor' });
    const h = await historyApp(store, scripted.access);
    const url = `/v1/sessions/${sid}/history`;

    const refused = await h.app.inject({
      method: 'DELETE',
      url,
      headers: await h.bearerOf(editor),
    });
    expect(refused.statusCode).toBe(403);
    expect(await blobs.list(historyPrefix(sid))).toHaveLength(2);

    const hostHeaders = await h.bearerOf(host);
    const done = await h.app.inject({ method: 'DELETE', url, headers: hostHeaders });
    expect(done.statusCode).toBe(204);
    const after = await h.app.inject({ method: 'GET', url, headers: hostHeaders });
    expect(after.json()).toEqual({ data: [], next_cursor: null, has_more: false });
    expect(await blobs.list(historyPrefix(sid))).toEqual([]);
    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]).toMatchObject({
      action: 'history.purge',
      meta: { frames: 450, blobs: 2 },
    });
    const retention = await db
      .selectFrom('history_retention')
      .select('session_id')
      .where('session_id', '=', sid)
      .execute();
    expect(retention).toEqual([]);
    // The other session keeps its history.
    expect((await store.read(other, 0, 200)).frames).toHaveLength(10);
    await h.app.close();
  });

  it('deletes blobs before rows, so a failed purge leaves only readable frames and resumes', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    await store.append(sid, storedRange(sid, 1, 100));
    await store.append(sid, storedRange(sid, 101, 200));
    // The second delete fails: the first blob and its rows are gone, the second stays whole.
    const realDelete = blobs.delete.bind(blobs);
    let deletes = 0;
    blobs.delete = (keys) => {
      deletes += 1;
      return deletes === 2 ? Promise.reject(new Error('store down')) : realDelete(keys);
    };
    await expect(store.purge(sid)).rejects.toThrow('store down');
    const read = await store.read(sid, 0, 200);
    expect(read.frames.map((f) => f.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 101));
    blobs.delete = realDelete;
    expect(await store.purge(sid)).toEqual({ deleted: 100, blobs: 1 });
    expect((await store.read(sid, 0, 200)).frames).toEqual([]);
    expect(blobs.objects.size).toBe(0);
  });

  it('purges an orphan blob nobody indexed', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    const orphan = encodeBatch(storedRange(sid, 1, 3));
    await blobs.put(historyBlobKey(sid, 1, 3), orphan.body);
    expect(await store.purge(sid)).toEqual({ deleted: 0, blobs: 1 });
    expect(blobs.objects.size).toBe(0);
  });

  it('lets B027 purge a workspace with history once the history hook ran (review finding)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const owner = await pgUser(test.db);
    const workspaceId = await pgWorkspace(test.db, owner);
    const sessions = [
      await pgSession(test.db, workspaceId, owner),
      await pgSession(test.db, workspaceId, owner),
    ];
    for (const sid of sessions) {
      await store.append(sid, storedRange(sid, 1, 20));
      await store.setExpiry(sid, new Date());
    }
    // A session without history is purged as a no-op.
    await pgSession(test.db, workspaceId, owner);
    await test.db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', workspaceId)
      .execute();
    const workspaces = createWorkspaceStore(test.db);
    // Without the hook the history's foreign keys stop the purge.
    await expect(workspaces.purge(workspaceId)).rejects.toMatchObject({ code: '23503' });

    const purger = createWorkspaceHistoryPurger({ db, store });
    expect(await purger.purgeWorkspace(workspaceId)).toEqual({ sessions: 3, frames: 40 });
    expect(blobs.objects.size).toBe(0);
    expect(await workspaces.purge(workspaceId)).toEqual({ purged: true });
    // A re-run finds nothing to do.
    expect(await purger.purgeWorkspace(workspaceId)).toEqual({ sessions: 0, frames: 0 });
  });

  it('computes retention from the plan’s history_days', () => {
    const ended = new Date('2026-10-08T00:00:00Z');
    expect(retentionExpiry(ended, 7).toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(retentionExpiry(ended, 0)).toEqual(ended);
  });
});
