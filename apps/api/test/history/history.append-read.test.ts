/**
 * Appending and reading history (B055; tests "history.append-read.test.ts") on Postgres 16
 * (DATABASE_URL, CI's integration job) with the in-memory blob store:
 *
 * - 1 000 frames appended; GET after_seq=0&limit=200 returns 1..200 in order with a cursor, and
 *   following the cursor returns all 1 000 with no gap or duplicate (acceptance 1);
 * - appending the same (sid, seq) twice keeps one row; a frame after a gap is accepted, but reads
 *   stop at the gap; `earliest_seq` is the earliest retained frame (acceptance 2);
 * - `ct` comes back byte for byte, over 100 random base64url values (acceptance 8);
 * - the Postgres `HistoryAccess`: roles from the live records, owners, share_history.
 */
import { randomBytes } from 'node:crypto';
import { validate } from '@centcom/contracts';
import type { HistoryDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHistoryStore,
  createMemoryBlobStore,
  createPostgresHistoryAccess,
  toStoredFrame,
  type AccessDatabase,
  type StoredFrame,
} from '../../src/modules/history/index.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgJoinSession,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import { historyApp, scriptedAccess, sequenced, storedRange } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('history on Postgres 16', () => {
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
    const wsp = await pgWorkspace(test.db, owner);
    return pgSession(test.db, wsp, owner);
  }

  it('pages 1 000 frames in order through the cursor, with no gap or duplicate (acceptance 1)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    for (let first = 1; first <= 1000; first += 250) {
      await store.append(sid, storedRange(sid, first, first + 249));
    }
    const scripted = scriptedAccess();
    const user = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    scripted.set(sid, user, { role: 'viewer' });
    const h = await historyApp(store, scripted.access);
    const headers = await h.bearerOf(user);
    const first = await h.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}/history?after_seq=0&limit=200`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      data: { seq: number }[];
      next_cursor: string | null;
      has_more: boolean;
    }>();
    expect(validate('api/HistoryPage', page1).ok).toBe(true);
    expect(page1.data.map((f) => f.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(page1.next_cursor).toEqual(expect.any(String));
    expect(page1).toMatchObject({ has_more: true, earliest_seq: 1, head_seq: 1000 });

    const seen = [...page1.data.map((f) => f.seq)];
    let cursor = page1.next_cursor;
    let follows = 0;
    while (cursor !== null) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1/sessions/${sid}/history?limit=200&cursor=${encodeURIComponent(cursor)}`,
        headers,
      });
      const page = res.json<{ data: { seq: number }[]; next_cursor: string | null }>();
      seen.push(...page.data.map((f) => f.seq));
      cursor = page.next_cursor;
      follows += 1;
    }
    expect(follows).toBeLessThanOrEqual(5);
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    await h.app.close();
  });

  it('keeps one row per (sid, seq), and reads stop at a gap (acceptance 2)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    const frames = storedRange(sid, 1, 5);
    const [one, two, three, , five] = frames as [
      StoredFrame,
      StoredFrame,
      StoredFrame,
      StoredFrame,
      StoredFrame,
    ];
    await store.append(sid, [one, two, three]);
    expect(await store.append(sid, [two, three])).toEqual({ lastSeq: 3 });
    expect(await store.append(sid, [five])).toEqual({ lastSeq: 5 });
    const rows = await db
      .selectFrom('history_index')
      .select('seq')
      .where('session_id', '=', sid)
      .orderBy('seq')
      .execute();
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 5]);
    // A re-append of indexed frames writes no blob.
    expect(blobs.objects.size).toBe(2);

    const read = await store.read(sid, 0, 200);
    expect(read.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(read).toMatchObject({ nextAfterSeq: null, earliestSeq: 1, headSeq: 5 });
    expect((await store.read(sid, 3, 200)).frames).toEqual([]);
    expect((await store.read(sid, 4, 200)).frames.map((f) => f.seq)).toEqual([5]);

    // Once 4 arrives the range is whole.
    await store.append(sid, [frames[3] as StoredFrame]);
    expect((await store.read(sid, 0, 200)).frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);

    // Older frames gone (retention): reading from 0 starts at the earliest retained one.
    await db
      .deleteFrom('history_index')
      .where('session_id', '=', sid)
      .where('seq', 'in', ['1', '2'])
      .execute();
    const later = await store.read(sid, 0, 200);
    expect(later.earliestSeq).toBe(3);
    expect(later.frames.map((f) => f.seq)).toEqual([3, 4, 5]);
  });

  it('returns ct byte for byte (acceptance 8)', async () => {
    const blobs = createMemoryBlobStore();
    const store = createHistoryStore({ db, blobs });
    const sid = await newSession();
    const sent: StoredFrame[] = [];
    for (let seq = 1; seq <= 100; seq++) {
      const raw = randomBytes(1 + (seq % 97)).toString('base64url');
      const converted = toStoredFrame(sequenced(sid, seq, { c: raw }));
      if (!converted.ok) throw new Error('refused');
      sent.push(converted.frame);
    }
    await store.append(sid, sent.slice(0, 37));
    await store.append(sid, sent.slice(37));
    const back = (await store.read(sid, 0, 200)).frames;
    expect(back).toHaveLength(100);
    for (const [i, frame] of back.entries()) {
      expect(JSON.stringify(frame.ct)).toBe(JSON.stringify(sent[i]?.ct));
    }
  });

  it('answers who a user is in a session from the live records', async () => {
    const access = createPostgresHistoryAccess(test.db as unknown as Kysely<AccessDatabase>);
    const owner = await pgUser(test.db);
    const wsp = await pgWorkspace(test.db, owner);
    await pgJoin(test.db, wsp, owner, 'owner');
    const sid = await pgSession(test.db, wsp, owner);
    const editor = await pgUser(test.db);
    await pgJoin(test.db, wsp, editor, 'member');
    await pgJoinSession(test.db, sid, editor);
    const stranger = await pgUser(test.db);

    expect(await access.standing(sid, { userId: owner })).toEqual({
      workspaceId: wsp,
      role: null,
      workspaceOwner: true,
      shareLinkGuest: false,
      shareHistory: true,
    });
    expect((await access.standing(sid, { userId: editor }))?.role).toEqual(expect.any(String));
    expect(await access.standing(sid, { userId: stranger })).toMatchObject({
      role: null,
      workspaceOwner: false,
    });
    expect(await access.standing('ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W', { userId: owner })).toBeNull();

    // Removed from the workspace: no longer a participant.
    await test.db.deleteFrom('memberships').where('user_id', '=', editor).execute();
    expect((await access.standing(sid, { userId: editor }))?.role).toBeNull();
  });
});
