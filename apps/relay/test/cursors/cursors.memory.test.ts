/**
 * Constant memory under a flood (B048; tests "cursors.memory.test.ts", acceptance 7, guardrail "no
 * queue of cursors"): 1 000 000 cursors offered by 20 members hold one slot per member, at most one
 * pending cursor each, and the heap does not grow with the number offered; slots of members who
 * left, or idle for a minute, go.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { ctOf, cursorUnit } from './helpers.js';

describe('a flood of 1 000 000 cursors (acceptance 7)', () => {
  it('holds one slot per member; the heap stays flat', () => {
    const u = cursorUnit({ inPerSecond: 1_000 });
    const members = Array.from({ length: 20 }, () => newId('mem'));
    for (const m of members) u.join(m);
    const ct = ctOf(100);
    const start = u.time.now();
    const offer = (i: number) =>
      u.throttle.offer(
        u.sid,
        members[i % members.length] as string,
        { ct },
        start + Math.floor(i / 100),
      );
    for (let i = 0; i < 100_000; i += 1) offer(i);
    const heapAfterWarmup = process.memoryUsage().heapUsed;
    for (let i = 100_000; i < 1_000_000; i += 1) offer(i);
    const grown = process.memoryUsage().heapUsed - heapAfterWarmup;
    expect(u.throttle.slots()).toBe(members.length);
    // 900 000 more offers would take hundreds of MB if anything were queued.
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);

  it('forgets the slots of members who left, and those idle for a minute', async () => {
    const u = cursorUnit();
    const a = u.join();
    const b = u.join();
    await u.cursor(a);
    await u.cursor(b);
    expect(u.throttle.slots()).toBe(2);
    u.throttle.forget(u.sid, a.entry.memberId ?? '');
    expect(u.throttle.slots()).toBe(1);
    u.time.advance(61_000);
    u.time.advance(60_000);
    expect(u.throttle.slots()).toBe(0);
  });
});
