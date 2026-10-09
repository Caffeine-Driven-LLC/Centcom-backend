/**
 * The rate of `sys.slow_down` (B046; tests "backpressure.slowdown-rate.test.ts", acceptance 4,
 * guardrail "never more than once per second"): 1 000 frames enqueued over the limit within a
 * second give one `sys.slow_down`; the next comes no sooner than a second later. It is written
 * straight to the socket (`send`), not through the sender the policy governs.
 */
import { describe, expect, it } from 'vitest';
import { controllerUnit, frameText, sysOf } from './helpers.js';

describe('one sys.slow_down per second (acceptance 4)', () => {
  it('1 000 frames over the limit within a second: one slow_down', () => {
    const u = controllerUnit();
    const conn = u.connect();
    conn.buffered = 3 * 1024 * 1024;
    for (let seq = 1; seq <= 1_000; seq += 1) {
      u.send(conn, frameText(u.sid, seq, 200));
      if (seq % 100 === 0) u.advance(90);
    }
    expect(sysOf(conn, 'sys.slow_down')).toHaveLength(1);
    u.advance(200);
    for (let seq = 1_001; seq <= 1_010; seq += 1) u.send(conn, frameText(u.sid, seq, 200));
    expect(sysOf(conn, 'sys.slow_down')).toHaveLength(2);
    expect(u.recorded.count('relay_backpressure_slow_downs_total')).toBe(2);
    // One grace, however many frames.
    expect(u.timers.pending.filter((t) => t.ms === 5_000)).toHaveLength(1);
  });

  it('goes out even though the buffer is full (straight to the socket)', () => {
    const u = controllerUnit();
    const conn = u.connect();
    conn.buffered = 3 * 1024 * 1024;
    u.send(conn, frameText(u.sid, 1, 200));
    expect(conn.frames()[0]?.['t']).toBe('sys.slow_down');
  });
});
