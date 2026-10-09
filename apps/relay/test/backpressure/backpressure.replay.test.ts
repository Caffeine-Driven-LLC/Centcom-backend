/**
 * Backpressure and resume (B046; tests "backpressure.replay.test.ts", acceptance 5 and 7):
 *
 * - replaying 5 000 frames to a slow reader, the replay waits on the controller (`whenDrained`)
 *   and the buffer never exceeds 2 MiB + one frame (256 KiB);
 * - end to end on a running relay: a client that stops reading is closed 4429 (`slow_consumer`)
 *   after the grace, and reconnecting with its `last_seq` it gets everything it missed (B042), so
 *   nothing is lost.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createBackpressure } from '../../src/backpressure/controller.js';
import { createBackpressureModule } from '../../src/backpressure/module.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { cluster, range, seqs } from '../cluster/helpers.js';
import { until } from '../helpers.js';
import { resumedOf, resumeUnit } from '../resume/helpers.js';
import { bufferedConnection, CONFIG, KiB, MiB } from './helpers.js';

describe('replay to a slow reader (acceptance 5)', () => {
  it('5 000 frames: never over 2 MiB + one frame buffered', async () => {
    let drain = (): void => undefined;
    const controller = createBackpressure({ config: CONFIG });
    const u = resumeUnit({
      resumer: {
        outbound: () => controller,
        sleep: () => {
          drain();
          return new Promise((resolve) => setImmediate(resolve));
        },
      },
    });
    const from = newId('mem');
    for (let i = 0; i < 5_000; i += 1) {
      const id = newId('msg');
      const frame = stampFrame(
        {
          t: 'event',
          id,
          k: 'message.user',
          ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'n'.repeat(32), c: 'c'.repeat(1_500) },
        },
        from,
        new Date().toISOString(),
        u.sid,
      );
      const { seq } = await u.store.assign(u.sid, { from, id }, frame, Date.now());
      await u.log.append(u.sid, withSeq(frame, seq));
    }
    const conn = bufferedConnection(u.registry, u.sid);
    controller.attach(conn);
    drain = () => conn.drain(48 * KiB);
    await u.connect(0, { conn });
    await u.settled(conn);
    controller.stop();
    expect(conn.seqs()).toEqual(range(1, 5_000));
    expect(resumedOf(conn)).toEqual([{ from_seq: 1, to_seq: 5_000, count: 5_000 }]);
    expect(conn.maxBuffered).toBeLessThanOrEqual(2 * MiB + 256 * KiB);
    expect(conn.maxBuffered).toBeGreaterThan(MiB);
  });
});

describe('closed for 4429, then resumed (acceptance 7)', () => {
  it('a client that stops reading is closed 4429 and resumes with last_seq without loss', async () => {
    const c = await cluster(1, {
      rate: 1_000_000,
      modules: () => [createBackpressureModule({ RELAY_SLOW_GRACE_MS: '500' })],
    });
    try {
      const node = c.nodes[0] as (typeof c.nodes)[0];
      const member = c.member();
      const slow = await c.client(node, member);
      const sender = await c.client(node);
      slow.stall();
      const big = () => ({
        v: 1 as const,
        t: 'event' as const,
        id: newId('msg'),
        sid: c.sid,
        k: 'message.user',
        ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'n'.repeat(32), c: 'c'.repeat(100 * 1024) },
        sig: 's'.repeat(86),
      });
      let sent = 0;
      // Enough 100 KiB frames to fill the kernel's buffers and then 2 MiB of the relay's.
      while (sent < 600 && slow.closeInfo === undefined) {
        await Promise.all(Array.from({ length: 20 }, () => sender.sendFrame(big() as never)));
        sent += 20;
        if (node.relay.recorded.count('relay_backpressure_closed_total', { reason: 'grace' }) > 0)
          break;
      }
      await until(
        () =>
          node.relay.recorded.count('relay_backpressure_closed_total', { reason: 'grace' }) === 1,
        5_000,
      );
      slow.unstall();
      await until(() => slow.closeInfo !== undefined, 5_000);
      expect(slow.closeInfo?.code === 4429 || slow.closeInfo?.code === 1006).toBe(true);
      // Traffic goes on while it is away.
      await Promise.all(Array.from({ length: 20 }, () => sender.sendFrame(big() as never)));
      sent += 20;
      const kept = slow.lastSeq;
      expect(kept).toBeLessThan(sent);
      const back = await c.client(node, member, kept);
      await until(() => back.lastSeq === sent, 10_000);
      const got = [...seqs(slow).filter((s) => s <= kept), ...seqs(back)];
      expect(got).toEqual(range(1, sent));
    } finally {
      await c.stop();
    }
  }, 60_000);
});
