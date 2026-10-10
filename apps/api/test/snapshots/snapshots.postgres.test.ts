/**
 * B056 on Postgres 16 (DATABASE_URL, CI's integration job): the repository's rules (the pending
 * cap under concurrent begins, conditional commits, latest by seq, keep-3, expiry, `deleting`), the
 * audit events written in the row change's transaction, B055's access deciding host and
 * participants, ON DELETE RESTRICT, and the table's columns.
 */
import { newId } from '@centcom/contracts';
import { createAuditEmitter } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import { createPostgresHistoryAccess } from '../../src/modules/history/index.js';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PENDING, PENDING_TTL_MS } from '../../src/modules/snapshots/ports.js';
import {
  createSnapshotRepository,
  type SnapshotsDb,
} from '../../src/modules/snapshots/repository.js';
import {
  SNAPSHOT_AUDIT_ACTIONS,
  SnapshotService,
  snapshotSeqLookup,
} from '../../src/modules/snapshots/service.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgJoinSession,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import { ciphertext, memoryObjects } from './helpers.js';

type TestDatabase = Awaited<ReturnType<typeof migratedDatabase>>;

describe.runIf(ADMIN_URL !== undefined)('snapshots on Postgres 16', () => {
  let test: TestDatabase;
  let db: Kysely<CoreDatabase>;
  beforeAll(async () => {
    test = await migratedDatabase(10);
    db = test.db as unknown as Kysely<CoreDatabase>;
  }, 120_000);
  afterAll(async () => {
    await test?.drop();
  });

  /** A workspace session with a host, an editor and an outsider of the workspace. */
  async function setup() {
    // A fixed clock in the past for created_at: the rows never meet the database's now().
    const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
    const owner = await pgUser(db);
    const ws = await pgWorkspace(db, owner);
    await pgJoin(db, ws, owner, 'owner');
    const host = await pgUser(db);
    await pgJoin(db, ws, host, 'member');
    const editor = await pgUser(db);
    await pgJoin(db, ws, editor, 'member');
    const outsider = await pgUser(db);
    const sid = await pgSession(db, ws, owner);
    const hostMember = await pgJoinSession(db, sid, host);
    await db
      .updateTable('session_members')
      .set({ role: 'host' })
      .where('id', '=', hostMember)
      .execute();
    await pgJoinSession(db, sid, editor);
    const rows = createSnapshotRepository(db as unknown as Kysely<SnapshotsDb>);
    const store = memoryObjects();
    const audit = createAuditEmitter({ db, actions: SNAPSHOT_AUDIT_ACTIONS });
    const service = new SnapshotService({
      rows,
      objects: store.objects,
      access: createPostgresHistoryAccess(db as never),
      audit,
      clock: () => clock.now,
    });
    const snapshot = async (seq: number) => {
      const data = ciphertext(256);
      const grant = await service.begin(sid, { userId: host }, { size: 256, kid: 'k1' });
      store.upload(grant.uploadUrl, data.bytes, new Date(clock.now));
      const d = await service.commit(
        sid,
        grant.snp,
        { seq, sha256: data.sha256, size: 256, kid: 'k1' },
        { userId: host },
      );
      clock.now += 1000;
      return { grant, d };
    };
    return { clock, ws, sid, host, editor, outsider, rows, store, service, snapshot };
  }

  it('ten concurrent begins: three pending rows, seven 429s', async () => {
    const env = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        env.service.begin(env.sid, { userId: env.host }, { size: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_PENDING);
    const pending = await db
      .selectFrom('snapshot' as never)
      .select(sql<string>`count(*)`.as('n'))
      .where(sql.ref('session_id'), '=', env.sid)
      .executeTakeFirstOrThrow();
    expect(Number((pending as { n: string }).n)).toBe(3);
  });

  it('commits, keeps the newest 3 by seq, serves the highest seq, audits in the transaction', async () => {
    const env = await setup();
    for (const seq of [100, 200, 300, 400]) await env.snapshot(seq);
    const low = await env.snapshot(150);
    const left = await sql<{ seq: string; state: string }>`
      select seq, state from snapshot where session_id = ${env.sid} order by seq`.execute(db);
    // The latest (400) and the two most recent commits (150, 300) stay (acceptance 6: stored).
    expect(left.rows.map((r) => Number(r.seq))).toEqual([150, 300, 400]);
    expect(low.d.seq).toBe(150);
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(400);
    expect(await snapshotSeqLookup(env.service).latestSeq(env.sid)).toBe(400);
    const audits = await sql<{ action: string; meta: Record<string, unknown> }>`
      select action, meta from audit_events where target_id in (
        select snp from snapshot where session_id = ${env.sid}) order by created_at`.execute(db);
    expect(audits.rows.map((r) => r.action)).toContain('snapshot.commit');
    expect(audits.rows.every((r) => !JSON.stringify(r.meta).includes('sha256'))).toBe(true);
  });

  it('host only for begin; editor 403; outsider 404 (B055 access)', async () => {
    const env = await setup();
    await expect(
      env.service.begin(env.sid, { userId: env.editor }, { size: 1 }),
    ).rejects.toMatchObject({ code: 'host_required' });
    await expect(
      env.service.begin(env.sid, { userId: env.outsider }, { size: 1 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await env.snapshot(1);
    await expect(env.service.latestFor(env.sid, { userId: env.editor })).resolves.toMatchObject({
      descriptor: { seq: 1 },
    });
  });

  it('no committed snapshot: latest() is null for the relay (acceptance 8)', async () => {
    const env = await setup();
    await env.service.begin(env.sid, { userId: env.host }, { size: 1 });
    expect(await env.service.latest(env.sid)).toBeNull();
    expect(await snapshotSeqLookup(env.service).latestSeq(env.sid)).toBeNull();
  });

  it('expires pending uploads after 15 min; conditional state changes win once', async () => {
    const env = await setup();
    const old = await env.service.begin(env.sid, { userId: env.host }, { size: 1 });
    env.clock.now += PENDING_TTL_MS + 1;
    const young = await env.service.begin(env.sid, { userId: env.host }, { size: 1 });
    expect((await env.service.pruner.prune()).expired).toBeGreaterThanOrEqual(1);
    expect(await env.rows.get(env.sid, old.snp)).toBeNull();
    expect((await env.rows.get(env.sid, young.snp))?.state).toBe('pending');
    // A row marked deleting cannot be committed, and is marked only once.
    expect(await env.rows.markDeleting([young.snp], 'pending')).toEqual([young.snp]);
    expect(await env.rows.markDeleting([young.snp], 'pending')).toEqual([]);
    expect(
      await env.rows.commit(
        env.sid,
        young.snp,
        { seq: 1, sha256: ciphertext(1).sha256, kid: 'k', committedAt: new Date(env.clock.now) },
        () => Promise.resolve(),
      ),
    ).toBeNull();
    expect((await env.rows.deleting(10, env.sid)).map((r) => r.snp)).toEqual([young.snp]);
  });

  it('a session with snapshots cannot be deleted before purgeSession', async () => {
    const env = await setup();
    await env.snapshot(1);
    const fk = await sql<{ confdeltype: string }>`
      select confdeltype from pg_constraint
      where conrelid = 'snapshot'::regclass and contype = 'f'`.execute(db);
    expect(fk.rows.map((r) => r.confdeltype)).toEqual(['r']);
    await env.service.purgeSession(env.sid);
    expect((await env.rows.allOf(env.sid)).length).toBe(0);
    expect(env.store.blobs.objects.size).toBe(0);
  });

  it('stores only the descriptor columns', async () => {
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'snapshot' order by ordinal_position`.execute(db);
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'snp',
      'session_id',
      'state',
      'seq',
      'size',
      'sha256',
      'kid',
      'blob_key',
      'created_at',
      'committed_at',
    ]);
    expect(newId('snp')).toMatch(/^snp_/);
  });
});
