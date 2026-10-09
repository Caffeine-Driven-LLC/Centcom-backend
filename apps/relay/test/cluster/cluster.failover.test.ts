/**
 * Losing a node (B045; tests "cluster.failover.test.ts", acceptance 8): node A is killed mid-run;
 * clients on node B keep receiving, in order; A's clients reconnect to B with their `last_seq`
 * (B042) and get every frame they missed, so nothing is lost.
 */
import { describe, expect, it } from 'vitest';
import { until } from '../helpers.js';
import { reaction } from '../seq/helpers.js';
import { cluster, range, seqs } from './helpers.js';

describe('node loss (acceptance 8)', () => {
  it('clients on B continue; A’s clients resume on B with no loss', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = c.nodes as [(typeof c.nodes)[0], (typeof c.nodes)[0]];
      const onB = await c.client(b);
      const member = c.member();
      const onA = await c.client(a, member);
      const sender = await c.client(b);
      for (let i = 0; i < 50; i += 1) await sender.send('reaction', reaction());
      await until(() => onA.lastSeq === 50 && onB.lastSeq === 50);
      // Node A dies; traffic goes on through B.
      await c.stopNode(a);
      await until(() => !onA.isOpen);
      const kept = onA.lastSeq;
      for (let i = 0; i < 50; i += 1) await sender.send('reaction', reaction());
      await until(() => onB.lastSeq === 100);
      expect(seqs(onB)).toEqual(range(1, 100));
      // A's client comes back on B with its last_seq.
      const back = await c.client(b, member, kept);
      expect(back.welcome?.resume).toEqual({ from_seq: kept + 1, to_seq: 100 });
      for (let i = 0; i < 10; i += 1) await sender.send('reaction', reaction());
      await until(() => back.lastSeq === 110, 5_000);
      expect([...seqs(onA), ...seqs(back)]).toEqual(range(1, 110));
    } finally {
      await c.stop();
    }
  }, 30_000);
});
