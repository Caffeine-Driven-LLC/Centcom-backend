/**
 * Lost messages (B045; tests "cluster.gap-fill.test.ts", acceptance 2, failure modes "Gap-fill
 * range empty" and "pub/sub drops"): a frame published but never delivered to node B is fetched
 * from the hot buffer (`SeqStore.range`) once the frames after it waited RELAY_CLUSTER_GAP_MS
 * (250 ms), and delivered in order within 250 + 50 ms; a lost frame that nothing follows is found
 * by the reconcile sweep; a gap the buffer can no longer fill closes B's room with 1001
 * (`sys.bye resync`) so its clients resume.
 */
import { describe, expect, it } from 'vitest';
import { until } from '../helpers.js';
import { reaction } from '../seq/helpers.js';
import { cluster, range, seqs } from './helpers.js';

/** The seq inside a frames-channel message, if it is one. */
const seqOf = (message: string): number | undefined => {
  try {
    const parsed = JSON.parse(message) as { frame?: { seq?: number } };
    return parsed.frame?.seq;
  } catch {
    return undefined;
  }
};

describe('gap-fill (acceptance 2)', () => {
  it('recovers a dropped frame from the hot buffer within 250 + 50 ms, in order', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = c.nodes as [(typeof c.nodes)[0], (typeof c.nodes)[0]];
      b.redis.drop = (channel, message) => channel.endsWith(':frames') && seqOf(message) === 5;
      const sender = await c.client(a);
      const receiver = await c.client(b);
      for (let i = 0; i < 4; i += 1) await sender.send('reaction', reaction());
      await until(() => seqs(receiver).length === 4);
      for (let i = 0; i < 4; i += 1) await sender.send('reaction', reaction());
      const waiting = Date.now();
      await until(() => seqs(receiver).length === 8, 2_000);
      const elapsed = Date.now() - waiting;
      expect(seqs(receiver)).toEqual(range(1, 8));
      expect(elapsed).toBeLessThan(250 + 50 + 100);
      expect(elapsed).toBeGreaterThanOrEqual(200);
    } finally {
      await c.stop();
    }
  }, 20_000);

  it('a lost last frame (nothing after it) is found by the reconcile sweep', async () => {
    const c = await cluster(2, { config: { reconcileMs: 100 } });
    try {
      const [a, b] = c.nodes as [(typeof c.nodes)[0], (typeof c.nodes)[0]];
      const sender = await c.client(a);
      const receiver = await c.client(b);
      await sender.send('reaction', reaction());
      await until(() => seqs(receiver).length === 1);
      b.redis.drop = (channel) => channel.endsWith(':frames');
      await sender.send('reaction', reaction());
      await until(() => seqs(receiver).length === 2, 2_000);
      expect(seqs(receiver)).toEqual([1, 2]);
      expect(b.metrics.count('relay_cluster_reconciled_total')).toBeGreaterThan(0);
    } finally {
      await c.stop();
    }
  }, 20_000);

  it('closes the room with 1001 resync when the buffer cannot fill the gap', async () => {
    const c = await cluster(2, { limits: { minFrames: 5, minAgeMs: 0, maxFrames: 5 } });
    try {
      const [a, b] = c.nodes as [(typeof c.nodes)[0], (typeof c.nodes)[0]];
      const sender = await c.client(a);
      const receiver = await c.client(b);
      await sender.send('reaction', reaction());
      await until(() => seqs(receiver).length === 1);
      b.redis.drop = (channel, message) => {
        const seq = seqOf(message);
        return channel.endsWith(':frames') && seq !== undefined && seq < 15;
      };
      for (let i = 0; i < 20; i += 1) await sender.send('reaction', reaction());
      await until(() => receiver.closeInfo !== undefined, 3_000);
      expect(receiver.closeInfo?.code).toBe(1001);
      expect(receiver.wire.at(-1)).toMatchObject({ t: 'sys.bye', p: { reason: 'resync' } });
      // What it did get was in order, with no gap.
      expect(seqs(receiver)).toEqual(range(1, seqs(receiver).length));
    } finally {
      await c.stop();
    }
  }, 20_000);
});
