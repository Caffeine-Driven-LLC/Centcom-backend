/**
 * The 100 ms fan-out (B048; tests "cursors.tick.test.ts", acceptance 2 and 6, guardrails "only the
 * latest per member" and "opaque"): two members sending steadily produce at most one frame per
 * member per tick to each peer; a slot that did not change sends nothing; the frame carries the
 * server's `from`, `ct` and `sig` as they came, no `seq`, and goes to the other nodes too. A
 * connection over its soft watermark (B046) has its cursor frames dropped and counted; nothing else
 * changes.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createBackpressure } from '../../src/backpressure/controller.js';
import { bufferedConnection, CONFIG as BP } from '../backpressure/helpers.js';
import { ctOf, cursorsOf, cursorUnit } from './helpers.js';

describe('the tick (acceptance 2)', () => {
  it('at most one frame per member per 100 ms to each peer; nothing when unchanged', async () => {
    const u = cursorUnit();
    const [a, b, peer] = [u.join(), u.join(), u.join()];
    const start = u.time.now();
    const ticks: number[][] = [];
    for (let step = 0; step < 30; step += 1) {
      u.time.advanceTo(start + step * 30);
      // Each member sends every 90 ms (11/s: one is over the rate now and then).
      if (step % 3 === 0) {
        await u.cursor(a);
        await u.cursor(b);
      }
    }
    u.time.advanceTo(start + 1_000);
    for (const member of [a, b]) {
      const frames = cursorsOf(peer, member.entry.memberId ?? '');
      const bySlot = new Map<number, number>();
      for (const f of frames) {
        const tick = Math.floor((Date.parse(f['ts'] as string) - start) / 100);
        bySlot.set(tick, (bySlot.get(tick) ?? 0) + 1);
      }
      expect(frames.length).toBeGreaterThan(0);
      ticks.push([...bySlot.values()]);
    }
    for (const counts of ticks) for (const n of counts) expect(n).toBeLessThanOrEqual(1);
    // Quiet now: no more frames.
    const before = cursorsOf(peer).length;
    u.time.advance(2_000);
    expect(cursorsOf(peer).length).toBe(before);
  });

  it('stamps from, carries ct and sig unchanged, no seq; publishes to other nodes', async () => {
    const u = cursorUnit();
    const member = newId('mem');
    const sender = u.join(member);
    const peer = u.join();
    const ct = ctOf(300);
    await u.cursor(sender, ct, { from: newId('mem'), seq: 99 });
    u.time.advance(100);
    const [frame] = cursorsOf(peer);
    expect(frame).toMatchObject({
      t: 'presence',
      k: 'presence.cursor',
      from: member,
      sid: u.sid,
      ct,
      sig: 's'.repeat(86),
    });
    expect(frame).not.toHaveProperty('seq');
    expect(u.published).toEqual([frame]);
    // Not back to the sender's own connections.
    expect(cursorsOf(sender)).toEqual([]);
  });
});

describe('under backpressure (acceptance 6)', () => {
  it('drops cursor frames for a connection over its soft mark, and counts them', async () => {
    const u = cursorUnit();
    const controller = createBackpressure({ config: BP });
    const sender = u.join();
    const healthy = u.join();
    const stalled = bufferedConnection(u.registry, u.sid);
    u.rooms.getOrCreate(u.sid).join(stalled, {
      id: stalled.entry.memberId ?? '',
      sid: u.sid,
      role: 'viewer',
      userId: newId('usr'),
      workspaceId: null,
      name: 'S',
      slot: 0,
    });
    controller.attach(stalled);
    stalled.buffered = BP.softBytes + 1;
    for (let i = 0; i < 5; i += 1) {
      await u.cursor(sender);
      u.time.advance(100);
    }
    expect(cursorsOf(healthy)).toHaveLength(5);
    expect(cursorsOf(stalled)).toHaveLength(0);
    expect(u.recorded.count('relay_cursors_forwarded_total', { result: 'dropped' })).toBe(5);
    expect(stalled.closedWith).toBeNull();
    controller.stop();
  });
});
