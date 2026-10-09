/**
 * Isolation and failure modes (B044; tests "fanout.isolation.test.ts", acceptance 5): a closed
 * connection is skipped and one whose send throws does not stop delivery to the rest; a frame of a
 * session without a room is still sequenced and its delivery skipped (counted); a gap that does
 * not fill in 250 ms is filled from the hot buffer, and one the buffer cannot fill closes the
 * room's connections with 1001 (`sys.bye resync`) so clients resume; the RemoteDispatcher gets
 * every locally sequenced frame, and its failures never touch delivery.
 */
import { describe, expect, it } from 'vitest';
import { createFanOut } from '../../src/fanout/fanout.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { recordingMetrics } from '../helpers.js';
import {
  fanoutUnit,
  manualTimers,
  newId,
  reactionFrame,
  textConnection,
  type TextConnection,
} from './helpers.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('isolation (acceptance 5)', () => {
  it('skips a closed connection and survives a throwing one', async () => {
    const u = fanoutUnit();
    const [a, closed, broken, d] = [u.join(), u.join(), u.join(), u.join()] as TextConnection[] as [
      TextConnection,
      TextConnection,
      TextConnection,
      TextConnection,
    ];
    closed.close(1000 as never);
    broken.failing = true;
    await u.send(a, reactionFrame(u.sid));
    expect(a.seqs()).toEqual([1]);
    expect(d.seqs()).toEqual([1]);
    expect(closed.texts).toEqual([]);
    expect(broken.texts).toEqual([]);
    broken.failing = false;
    await u.send(a, reactionFrame(u.sid));
    expect(broken.seqs()).toEqual([2]);
  });

  it('counts each write and records the receipt-to-delivery latency', async () => {
    const recorded = recordingMetrics();
    const observed: { name: string; value: number }[] = [];
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const u = fanoutUnit({
      fanout: {
        clock: () => now,
        metrics: {
          ...recorded.metrics,
          histogram: (name) => ({ observe: (value) => void observed.push({ name, value }) }),
        },
      },
    });
    const [a, closed] = [u.join(), u.join()] as [TextConnection, TextConnection];
    closed.close(1000 as never);
    const frame = reactionFrame(u.sid);
    await u.store.assign(
      u.sid,
      { from: 'mem_x', id: frame.id },
      { ...frame, from: 'mem_x', ts: new Date(now).toISOString() } as never,
      0,
    );
    const [stored] = await u.store.range(u.sid, 0, 1);
    now += 40;
    u.fanout.deliver(u.sid, stored as StoredFrame);
    expect(a.seqs()).toEqual([1]);
    expect(recorded.count('relay_fanout_deliveries_total', { result: 'queued' })).toBe(1);
    expect(recorded.count('relay_fanout_deliveries_total', { result: 'closed' })).toBe(1);
    expect(observed).toEqual([{ name: 'relay_fanout_latency_seconds', value: 0.04 }]);
  });

  it('sequences a frame of a session without a room and skips its delivery', async () => {
    const recorded = recordingMetrics();
    const u = fanoutUnit({ fanout: { metrics: recorded.metrics } });
    // A welcomed connection whose session has no room on this node.
    const a = textConnection(u.registry, u.sid);
    u.sequencer.onConnection(a);
    const stored = await u.send(a, reactionFrame(u.sid));
    expect(stored?.seq).toBe(1);
    expect(await u.store.head(u.sid)).toBe(1);
    expect(recorded.count('relay_fanout_deliveries_total', { result: 'no_room' })).toBe(1);
  });
});

describe('gaps', () => {
  function frame(sid: string, seq: number): StoredFrame {
    return {
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid,
      from: newId('mem'),
      ts: new Date().toISOString(),
      seq,
      k: 'reaction',
    } as StoredFrame;
  }

  it('fills a lost offer from the hot buffer after 250 ms', async () => {
    const u = fanoutUnit();
    const a = u.join();
    // 1 and 2 are sequenced; only 1 and 3 reach fan-out (2's offer was lost).
    for (let i = 0; i < 3; i++)
      await u.store.assign(
        u.sid,
        { from: 'mem_x', id: `msg_${i}` },
        { ...reactionFrame(u.sid), from: 'mem_x', ts: 't', id: `msg_${i}` } as never,
        0,
      );
    const buffered = await u.store.range(u.sid, 0, 3);
    u.fanout.deliver(u.sid, buffered[0] as StoredFrame);
    u.fanout.deliver(u.sid, buffered[2] as StoredFrame);
    expect(a.seqs()).toEqual([1]);
    u.timers.fire();
    await settle();
    expect(a.seqs()).toEqual([1, 2, 3]);
  });

  it('closes the room with 1001 resync when the buffer cannot fill the gap', async () => {
    const timers = manualTimers();
    const recorded = recordingMetrics();
    const u = fanoutUnit();
    const fanout = createFanOut({
      rooms: u.rooms,
      seq: { ...u.sequencer.service, store: { ...u.store, range: () => Promise.resolve([]) } },
      setTimer: timers.setTimer,
      metrics: recorded.metrics,
    });
    const [a, b] = [u.join(), u.join()] as [TextConnection, TextConnection];
    fanout.deliver(u.sid, frame(u.sid, 1));
    fanout.deliver(u.sid, frame(u.sid, 3));
    timers.fire();
    await settle();
    for (const conn of [a, b]) {
      expect(conn.closedWith).toBe(1001);
      expect(conn.frames().at(-1)).toMatchObject({ t: 'sys.bye', p: { reason: 'resync' } });
    }
    expect(fanout.release.expected(u.sid)).toBeNull();
    expect(recorded.count('relay_fanout_gaps_total', { result: 'resync' })).toBe(1);
  });

  it('hands every locally sequenced frame to the RemoteDispatcher, ignoring its failures', async () => {
    const recorded = recordingMetrics();
    const u = fanoutUnit({ fanout: { metrics: recorded.metrics } });
    const published: number[] = [];
    let fail = true;
    u.fanout.setRemoteDispatcher({
      publish: (_sid, f) =>
        fail
          ? Promise.reject(new Error('pubsub down'))
          : (published.push(f.seq), Promise.resolve()),
    });
    const a = u.join();
    await u.send(a, reactionFrame(u.sid));
    await settle();
    fail = false;
    await u.send(a, reactionFrame(u.sid));
    expect(a.seqs()).toEqual([1, 2]);
    expect(published).toEqual([2]);
    expect(recorded.count('relay_fanout_remote_failures_total')).toBe(1);
  });
});
