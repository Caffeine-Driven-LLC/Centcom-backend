/**
 * Replay from the hot buffer (B042; tests "resume.replay.test.ts", acceptance 1 and 2): a client
 * that left at 1040 while the head moved to 1100 gets the welcome, 1041..1100 once each and in
 * order, `sys.resumed {from_seq:1041, to_seq:1100, count:60}`, then live frames from 1101 with no
 * gap or duplicate, over 20 runs with traffic during the replay; `last_seq` = head replays nothing
 * (`count: 0`); `last_seq: null` replays nothing and `welcome.resume` is null; replayed frames are
 * the exact bytes live members got.
 */
import { describe, expect, it } from 'vitest';
import { recordingMetrics } from '../helpers.js';
import { framesOf, newId, resumedOf, resumeUnit, seqsOf, type TextConnection } from './helpers.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Frame types in arrival order, sequenced frames as their seq. */
const timeline = (conn: TextConnection): (string | number)[] =>
  framesOf(conn).map((f) => (typeof f['seq'] === 'number' ? f['seq'] : (f['t'] as string)));

describe('replay window (acceptance 1)', () => {
  it('sends the welcome, 1041..1100 in order, sys.resumed, then live frames', async () => {
    const u = resumeUnit();
    await u.seed(1100);
    const { conn, welcome } = await u.connect(1040);
    await u.settled(conn);
    expect(welcome).toEqual({ from_seq: 1041, to_seq: 1100 });
    expect(timeline(conn)).toEqual(['sys.welcome', ...range(1041, 1100), 'sys.resumed']);
    expect(resumedOf(conn)).toEqual([{ from_seq: 1041, to_seq: 1100, count: 60 }]);
    const other = u.join();
    for (let i = 0; i < 5; i += 1) await u.send(other);
    expect(seqsOf(conn)).toEqual(range(1041, 1105));
  });

  it('is gapless and duplicate-free with live traffic during the replay (20 runs)', async () => {
    for (let run = 0; run < 20; run += 1) {
      const u = resumeUnit();
      await u.seed(1100);
      const sender = u.join();
      const traffic = 20 + run * 3;
      const connecting = u.connect(1040);
      for (let i = 0; i < traffic; i += 1) {
        await u.send(sender);
        if (i % (run + 2) === 0) await turn();
      }
      const { conn } = await connecting;
      await u.settled(conn);
      const head = 1100 + traffic;
      expect(seqsOf(conn), `run ${run}`).toEqual(range(1041, head));
      const [resumed] = resumedOf(conn);
      expect(resumed?.['from_seq']).toBe(1041);
      const to = resumed?.['to_seq'] as number;
      expect(to).toBeGreaterThanOrEqual(1100);
      expect(resumed?.['count']).toBe(to - 1040);
      // sys.resumed comes right after the last replayed frame, and live frames after it.
      const line = timeline(conn);
      expect(line[line.indexOf('sys.resumed') - 1]).toBe(to);
      expect(line[0]).toBe('sys.welcome');
    }
  });
});

describe('empty replays (acceptance 2)', () => {
  it('last_seq equal to the head: sys.resumed {count: 0} and no frames', async () => {
    const u = resumeUnit();
    await u.seed(30);
    const { conn } = await u.connect(30);
    await u.settled(conn);
    expect(seqsOf(conn)).toEqual([]);
    expect(resumedOf(conn)).toEqual([{ from_seq: 31, to_seq: 30, count: 0 }]);
  });

  it('last_seq null: no replay, welcome.resume null, no sys.resumed, live frames flow', async () => {
    const u = resumeUnit();
    await u.seed(30);
    const { conn, welcome } = await u.connect(null);
    await u.settled(conn);
    expect(welcome).toBeNull();
    expect(resumedOf(conn)).toEqual([]);
    expect(seqsOf(conn)).toEqual([]);
    await u.send(u.join());
    expect(seqsOf(conn)).toEqual([31]);
  });

  it('a fresh session (head 0) with last_seq 0 resumes with count 0', async () => {
    const u = resumeUnit();
    const { conn } = await u.connect(0);
    await u.settled(conn);
    expect(resumedOf(conn)).toEqual([{ from_seq: 1, to_seq: 0, count: 0 }]);
  });
});

describe('byte-identical replay (guardrail)', () => {
  it('replays the exact text live members received, ct and sig included', async () => {
    const u = resumeUnit();
    const live = u.join();
    for (let i = 0; i < 40; i += 1) {
      await u.send(live, {
        v: 1,
        t: 'event',
        id: newId('msg'),
        sid: u.sid,
        ...(i % 3 === 0 ? { ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W' } : {}),
        k: 'message.user',
        ct: { alg: 'xchacha20poly1305', kid: 'k3', n: `n${i}`, c: `c${'x'.repeat(i)}` },
        sig: `sig${i}`,
      });
    }
    const { conn } = await u.connect(0);
    await u.settled(conn);
    const sequenced = (c: TextConnection) => c.texts.filter((t) => t.includes('"seq":'));
    expect(sequenced(conn)).toEqual(sequenced(live));
  });
});

describe('metrics', () => {
  it('counts resumes and replayed frames by source, and times them', async () => {
    const recorded = recordingMetrics();
    const observed: { name: string; labels: unknown }[] = [];
    const u = resumeUnit({
      limits: { minFrames: 100, minAgeMs: 0, maxFrames: 100 },
      resumer: {
        metrics: {
          ...recorded.metrics,
          histogram: (name) => ({
            observe: (_value, labels) => void observed.push({ name, labels }),
          }),
        },
      },
    });
    await u.seed(300);
    const { conn } = await u.connect(150);
    await u.settled(conn);
    const fresh = await u.connect(null);
    await u.settled(fresh.conn);
    expect(recorded.count('relay_resume_total', { result: 'replayed' })).toBe(1);
    // A batch is read from one source, picked by its first frame: 151..250 from the log, then
    // 251..300 from the buffer (201..300).
    expect(recorded.count('relay_replay_frames_total', { source: 'durable' })).toBe(100);
    expect(recorded.count('relay_replay_frames_total', { source: 'hot' })).toBe(50);
    expect(observed).toEqual([{ name: 'relay_resume_duration_seconds', labels: { result: 'ok' } }]);
  });
});
