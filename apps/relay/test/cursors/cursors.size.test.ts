/**
 * The size cap (B048; tests "cursors.size.test.ts", acceptance 3, guardrail "ct opaque: only its
 * size is checked"): a cursor whose `ct` serialises to 4 096 bytes is accepted; 4 097 bytes is
 * dropped with `sys.error invalid_frame` (pointer `/ct`), and the connection stays open. A missing
 * `ct` is dropped the same way.
 */
import { describe, expect, it } from 'vitest';
import { ctOf, cursorsOf, cursorUnit } from './helpers.js';

describe('the 4 KiB cap (acceptance 3)', () => {
  it('accepts 4 096 bytes, refuses 4 097 with invalid_frame and keeps the connection', async () => {
    const u = cursorUnit();
    const sender = u.join();
    const peer = u.join();
    const exact = ctOf(4_096);
    expect(JSON.stringify(exact).length).toBe(4_096);
    await u.cursor(sender, exact);
    u.time.advance(100);
    expect(cursorsOf(peer)).toHaveLength(1);
    const over = ctOf(4_097);
    expect(await u.cursor(sender, over, { id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W' })).toBe(true);
    const error = sender.frames().find((f) => f['t'] === 'sys.error');
    expect(error).toMatchObject({
      ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      p: { code: 'invalid_frame', errors: [{ pointer: '/ct' }] },
    });
    u.time.advance(100);
    expect(cursorsOf(peer)).toHaveLength(1);
    expect(sender.closedWith).toBeNull();
    expect(u.recorded.count('relay_cursors_total', { result: 'dropped_size' })).toBe(1);
  });

  it('a cursor without ct is refused the same way', async () => {
    const u = cursorUnit();
    const sender = u.join();
    const frame = { v: 1, t: 'presence', sid: u.sid, k: 'presence.cursor' };
    await u.stage({ connection: sender, raw: '', frame, state: {} }, () => Promise.resolve());
    expect(sender.frames().find((f) => f['t'] === 'sys.error')).toBeDefined();
  });

  it('other frames, and a cursor before the welcome, are left alone', async () => {
    const u = cursorUnit();
    const conn = u.join();
    let passed = 0;
    for (const frame of [{ v: 1, t: 'presence', k: 'presence.update', p: {} }, 'nope']) {
      await u.stage({ connection: conn, raw: '', frame, state: {} }, () => {
        passed += 1;
        return Promise.resolve();
      });
    }
    expect(passed).toBe(2);
    conn.entry.memberId = null;
    expect(await u.cursor(conn)).toBe(true);
    expect(u.recorded.count('relay_cursors_total', { result: 'accepted' })).toBe(0);
  });
});
