/**
 * Crash between batch flush and index insert (B055; tests "history.crash-recovery.test.ts",
 * acceptance 7) on Postgres 16 (DATABASE_URL):
 *
 * - a blob written whose index insert never happened is indexed by `repair` on restart, once:
 *   repairing twice, or the relay re-sending the same frames, adds no duplicate row;
 * - a retried append of the same range rewrites the same key (no second blob);
 * - repair leaves fully indexed blobs and other sessions alone.
 */
import type { HistoryDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHistoryStore,
  createMemoryBlobStore,
  encodeBatch,
  historyBlobKey,
} from '../../src/modules/history/index.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import { storedRange } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('history crash recovery on Postgres 16', () => {
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

  const rowCount = async (sid: string): Promise<number> =>
    (await db.selectFrom('history_index').select('seq').where('session_id', '=', sid).execute())
      .length;

  it('indexes a flushed but unindexed batch on repair, without duplicates (acceptance 7)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    await store.append(sid, storedRange(sid, 1, 10));

    // The crash: frames 11..20 reached the blob store, the process died before the index insert.
    const lost = encodeBatch(storedRange(sid, 11, 20));
    await blobs.put(historyBlobKey(sid, 11, 20), lost.body);
    expect(await rowCount(sid)).toBe(10);
    expect((await store.read(sid, 0, 200)).frames).toHaveLength(10);

    expect(await store.repair(sid)).toEqual({ indexed: 10 });
    expect(await rowCount(sid)).toBe(20);
    expect((await store.read(sid, 0, 200)).frames.map((f) => f.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // Repairing again, or the relay re-sending the frames, changes nothing.
    expect(await store.repair(sid)).toEqual({ indexed: 0 });
    await store.append(sid, storedRange(sid, 11, 20));
    expect(await rowCount(sid)).toBe(20);
    expect(blobs.objects.size).toBe(2);
  });

  it('rewrites the same key when the relay retries a batch that was never indexed', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    const batch = encodeBatch(storedRange(sid, 1, 5));
    await blobs.put(historyBlobKey(sid, 1, 5), batch.body);
    await store.append(sid, storedRange(sid, 1, 5));
    expect([...blobs.objects.keys()]).toEqual([historyBlobKey(sid, 1, 5)]);
    expect(await rowCount(sid)).toBe(5);
  });

  it('indexes only the missing frames of a partly indexed blob', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    await store.append(sid, storedRange(sid, 1, 6));
    await db
      .deleteFrom('history_index')
      .where('session_id', '=', sid)
      .where('seq', 'in', ['5', '6'])
      .execute();
    expect(await store.repair(sid)).toEqual({ indexed: 2 });
    expect(await rowCount(sid)).toBe(6);
  });
});
