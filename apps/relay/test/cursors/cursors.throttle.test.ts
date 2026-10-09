/**
 * The cursor rate and latest-wins (B048; tests "cursors.throttle.test.ts", acceptance 1, failure
 * mode "cursor flood"): 50 cursors from a member in one second: at most 10 accepted, the other
 * members get at most 10 frames for that member that second, and the last one they get is the last
 * accepted. A fast-check property over any arrival times: per second at most 10 accepted, peers
 * get only accepted values, in order, never one older than they had, and always the last
 * accepted. A member offering over 10x the limit every second for 10 seconds is closed 4429.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ctOf, cursorsOf, cursorUnit } from './helpers.js';

describe('50 cursors in a second (acceptance 1)', () => {
  it('10 accepted at most; peers get at most 10, ending with the last accepted', async () => {
    const u = cursorUnit();
    const sender = u.join();
    const peer = u.join();
    const start = u.time.now();
    const accepted: unknown[] = [];
    for (let i = 0; i < 50; i += 1) {
      u.time.advanceTo(start + i * 20);
      const ct = ctOf(120);
      const before = u.recorded.count('relay_cursors_total', { result: 'accepted' });
      await u.cursor(sender, ct);
      if (u.recorded.count('relay_cursors_total', { result: 'accepted' }) > before)
        accepted.push(ct);
    }
    u.time.advanceTo(start + 999);
    expect(accepted.length).toBeLessThanOrEqual(10);
    const got = cursorsOf(peer, sender.entry.memberId ?? '');
    expect(got.length).toBeLessThanOrEqual(10);
    expect(got.at(-1)?.['ct']).toEqual(accepted.at(-1));
    expect(u.recorded.count('relay_cursors_total', { result: 'dropped_rate' })).toBe(
      50 - accepted.length,
    );
  });
});

describe('any arrival times (property)', () => {
  it('caps the rate and delivers only accepted values, in order, ending with the latest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 250 }), { minLength: 1, maxLength: 120 }),
        async (gaps) => {
          const u = cursorUnit();
          const sender = u.join();
          const peer = u.join();
          const accepted: { at: number; c: string }[] = [];
          let t = u.time.now();
          for (const gap of gaps) {
            t += gap;
            u.time.advanceTo(t);
            const ct = ctOf(100);
            const before = u.recorded.count('relay_cursors_total', { result: 'accepted' });
            await u.cursor(sender, ct);
            if (u.recorded.count('relay_cursors_total', { result: 'accepted' }) > before) {
              accepted.push({ at: t, c: ct['c'] as string });
            }
          }
          u.time.advanceTo(t + 1_000);
          for (const a of accepted) {
            expect(
              accepted.filter((b) => b.at >= a.at && b.at < a.at + 1_000).length,
            ).toBeLessThanOrEqual(10);
          }
          const got = cursorsOf(peer).map((f) => (f['ct'] as { c: string }).c);
          const order = accepted.map((a) => a.c);
          let last = -1;
          for (const c of got) {
            const index = order.indexOf(c);
            expect(index).toBeGreaterThan(last);
            last = index;
          }
          expect(got.at(-1)).toBe(order.at(-1));
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe('floods', () => {
  it('closes a member offering over 10x the limit every second for 10 seconds with 4429', async () => {
    const u = cursorUnit();
    const flooder = u.join();
    const start = u.time.now();
    for (let second = 0; second <= 10 && flooder.closedWith === null; second += 1) {
      for (let i = 0; i < 120; i += 1) {
        u.time.advanceTo(start + second * 1_000 + i * 8);
        await u.cursor(flooder, ctOf(120));
      }
    }
    expect(flooder.closedWith).toBe(4429);
    expect(flooder.frames().find((f) => f['t'] === 'sys.error')?.['p']).toMatchObject({
      code: 'rate_limited',
    });
    expect(u.recorded.count('relay_cursor_flood_closed_total')).toBe(1);
  });

  it('does not close a member over the limit but under 10x it', async () => {
    const u = cursorUnit();
    const busy = u.join();
    const start = u.time.now();
    for (let i = 0; i < 12 * 50; i += 1) {
      u.time.advanceTo(start + i * 20);
      await u.cursor(busy, ctOf(120));
    }
    expect(busy.closedWith).toBeNull();
  });
});
