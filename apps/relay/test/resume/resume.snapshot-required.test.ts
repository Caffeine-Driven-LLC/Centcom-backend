/**
 * Snapshots and the durable log (B042; tests "resume.snapshot-required.test.ts", acceptance 3, 4
 * and 6, CT-RESUME "Flow" 2-4, failure modes): with a hot buffer of 100 frames (901..1000 of
 * 1000):
 *
 * - `last_seq` older than the buffer, or beyond the head, is `sys.resumed {snapshot_required,
 *   snapshot_seq}` with no frames, when a snapshot exists; `last_seq: null` replays nothing;
 * - `sys.resume {last_seq: S}` after it replays S+1..head in order, from the durable log and then
 *   the buffer, ending with a correct `sys.resumed`;
 * - a window over RELAY_REPLAY_MAX_FRAMES (50 000) is `snapshot_required`;
 * - without a snapshot `snapshot_required` is never sent: the relay replays from the durable log,
 *   with `history_gap` when frames after `last_seq` are gone;
 * - a durable log that fails is `sys.error` 503 with `retry_after_s`, the connection kept; a second
 *   concurrent `sys.resume` and a malformed one are `sys.error invalid_frame`.
 */
import { describe, expect, it } from 'vitest';
import {
  memoryLog,
  resumedOf,
  resumeUnit,
  seqsOf,
  snapshotsAt,
  type TextConnection,
} from './helpers.js';

const SMALL = { minFrames: 100, minAgeMs: 0, maxFrames: 100 };

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const resume = (lastSeq: unknown) => ({ v: 1, t: 'sys.resume', p: { last_seq: lastSeq } });

const errorsOf = (conn: TextConnection) =>
  conn
    .frames()
    .filter((f) => f['t'] === 'sys.error')
    .map((f) => f['p'] as Record<string, unknown>);

async function unitWith(snapshot: number | null, extra: Parameters<typeof resumeUnit>[0] = {}) {
  const u = resumeUnit({ limits: SMALL, snapshots: snapshotsAt(snapshot), ...extra });
  await u.seed(1000);
  expect(await u.store.oldest(u.sid)).toBe(901);
  return u;
}

describe('snapshot_required (acceptance 3)', () => {
  it('last_seq older than the buffer: snapshot_required at the latest snapshot, no frames', async () => {
    const u = await unitWith(800);
    const { conn, welcome } = await u.connect(500);
    await u.settled(conn);
    expect(welcome).toEqual({ snapshot_required: true, snapshot_seq: 800 });
    expect(resumedOf(conn)).toEqual([{ snapshot_required: true, snapshot_seq: 800 }]);
    expect(seqsOf(conn)).toEqual([]);
  });

  it('last_seq beyond the head: the same answer', async () => {
    const u = await unitWith(800);
    const { conn } = await u.connect(1200);
    await u.settled(conn);
    expect(resumedOf(conn)).toEqual([{ snapshot_required: true, snapshot_seq: 800 }]);
    expect(seqsOf(conn)).toEqual([]);
  });

  it('last_seq null: nothing replayed and no sys.resumed', async () => {
    const u = await unitWith(800);
    const { conn, welcome } = await u.connect(null);
    await u.settled(conn);
    expect(welcome).toBeNull();
    expect(resumedOf(conn)).toEqual([]);
  });

  it('live frames still reach a client told to load a snapshot', async () => {
    const u = await unitWith(800);
    const { conn } = await u.connect(500);
    await u.settled(conn);
    await u.send(u.join());
    expect(seqsOf(conn)).toEqual([1001]);
  });
});

describe('after the snapshot (acceptance 4, CT-RESUME Flow 3b)', () => {
  it('sys.resume {last_seq: S} replays S+1..head from the durable log, then the buffer', async () => {
    const u = await unitWith(800);
    const { conn } = await u.connect(500);
    await u.settled(conn);
    const reads = u.log.reads;
    await u.send(conn, resume(800));
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual(range(801, 1000));
    expect(resumedOf(conn).at(-1)).toEqual({ from_seq: 801, to_seq: 1000, count: 200 });
    expect(u.log.reads).toBeGreaterThan(reads);
  });
});

describe('the replay cap (acceptance 6)', () => {
  it('a window over 50 000 frames is answered with snapshot_required', async () => {
    const u = resumeUnit({ snapshots: snapshotsAt(40_000) });
    await u.seed(50_002);
    const { conn } = await u.connect(1);
    await u.settled(conn);
    expect(resumedOf(conn)).toEqual([{ snapshot_required: true, snapshot_seq: 40_000 }]);
    expect(seqsOf(conn)).toEqual([]);
  }, 30_000);

  it('a window of exactly the cap is replayed', async () => {
    const u = resumeUnit({ snapshots: snapshotsAt(1), resumer: { maxFrames: 300 } });
    await u.seed(400);
    const { conn, welcome } = await u.connect(100);
    await u.settled(conn);
    expect(welcome).toEqual({ from_seq: 101, to_seq: 400 });
    expect(seqsOf(conn)).toEqual(range(101, 400));
  });
});

describe('no snapshot (CT-RESUME Flow 4)', () => {
  it('replays from the durable log instead, without snapshot_required', async () => {
    const u = await unitWith(null);
    const { conn } = await u.connect(500);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual(range(501, 1000));
    expect(resumedOf(conn)).toEqual([{ from_seq: 501, to_seq: 1000, count: 500 }]);
  });

  it('marks history_gap when frames after last_seq are gone (retention)', async () => {
    const u = await unitWith(null);
    u.log.drop(u.sid, 600);
    const { conn } = await u.connect(500);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual(range(601, 1000));
    expect(resumedOf(conn)).toEqual([
      { from_seq: 601, to_seq: 1000, count: 400, history_gap: true },
    ]);
  });

  it('jumps to the buffer when the durable log has nothing before it', async () => {
    const u = await unitWith(null);
    u.log.drop(u.sid, 1000);
    const { conn } = await u.connect(500);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual(range(901, 1000));
    expect(resumedOf(conn)).toEqual([
      { from_seq: 901, to_seq: 1000, count: 100, history_gap: true },
    ]);
  });

  it('a client ahead of the server gets the newest frames to rebuild from, with history_gap', async () => {
    const u = await unitWith(null, { resumer: { maxFrames: 300 } });
    const { conn } = await u.connect(1200);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual(range(701, 1000));
    expect(resumedOf(conn)).toEqual([
      { from_seq: 701, to_seq: 1000, count: 300, history_gap: true },
    ]);
  });
});

describe('failures', () => {
  it('a durable log that fails is sys.error 503 with retry_after_s; the connection stays', async () => {
    const log = memoryLog();
    const u = await unitWith(800, { log });
    const { conn } = await u.connect(null);
    await u.settled(conn);
    log.failing = true;
    await u.send(conn, resume(800));
    await u.settled(conn);
    expect(errorsOf(conn).at(-1)).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    expect(conn.closedWith).toBeNull();
    await u.send(u.join());
    expect(seqsOf(conn).at(-1)).toBe(1001);
    log.failing = false;
    await u.send(conn, resume(800));
    await u.settled(conn);
    expect(resumedOf(conn).at(-1)).toEqual({ from_seq: 801, to_seq: 1001, count: 201 });
  });

  it('a second sys.resume while one runs is sys.error invalid_frame and is ignored', async () => {
    const u = await unitWith(800);
    const { conn } = await u.connect(null);
    await u.settled(conn);
    await u.send(conn, resume(800));
    await u.send(conn, { ...resume(900), id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    await u.settled(conn);
    expect(errorsOf(conn)).toEqual([expect.objectContaining({ code: 'invalid_frame' })]);
    expect(conn.frames().find((f) => f['t'] === 'sys.error')).toMatchObject({
      ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    });
    expect(resumedOf(conn)).toEqual([{ from_seq: 801, to_seq: 1000, count: 200 }]);
  });

  it('a sys.resume without a usable last_seq is sys.error invalid_frame', async () => {
    const u = await unitWith(800);
    const { conn } = await u.connect(null);
    await u.settled(conn);
    for (const bad of [null, -1, 1.5, '800', undefined]) await u.send(conn, resume(bad));
    expect(errorsOf(conn).map((e) => e['code'])).toEqual(Array(5).fill('invalid_frame'));
    expect(resumedOf(conn)).toEqual([]);
  });

  it('a sys.resume before the welcome (no session yet) is left to the handshake', async () => {
    const u = await unitWith(800);
    const conn = u.join();
    conn.entry.sessionId = null;
    const next: string[] = [];
    await u.resumer.stage({ connection: conn, raw: '', frame: resume(800), state: {} }, () =>
      Promise.resolve(void next.push('next')),
    );
    expect(next).toEqual([]);
    expect(conn.texts).toEqual([]);
  });
});
