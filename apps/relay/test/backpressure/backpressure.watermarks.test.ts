/**
 * Watermarks, grace and recovery (B046; tests "backpressure.watermarks.test.ts", acceptance 1 and
 * 2, guardrail "sequenced frames are never dropped"): a connection that stops reading while 100 KiB
 * frames are sent gets `sys.slow_down {for_ms: 2000, reason: "outbound"}` once its buffer passes
 * 2 MiB (within 100 KiB), and is closed 4429 (`sys.error slow_consumer`) 5 s later (within 0.5 s:
 * the close jitter) unless it got back under 1 MiB; one that drains in time is not closed and gets
 * every frame, in order. Timers go when the connection closes.
 */
import { describe, expect, it } from 'vitest';
import { SLOW_DOWN_FOR_MS } from '../../src/backpressure/controller.js';
import { controllerUnit, frameText, KiB, MiB, sysOf } from './helpers.js';

describe('a client that stops reading (acceptance 1)', () => {
  it('slow_down past 2 MiB, then 4429 at 5 s if it did not drain under 1 MiB', async () => {
    const u = controllerUnit();
    const conn = u.connect();
    let at: number | null = null;
    for (let seq = 1; seq <= 30 && at === null; seq += 1) {
      expect(u.send(conn, frameText(u.sid, seq))).toBe('queued');
      if (sysOf(conn, 'sys.slow_down').length > 0) at = conn.buffered;
    }
    expect(at).not.toBeNull();
    expect(Math.abs((at ?? 0) - 2 * MiB)).toBeLessThanOrEqual(100 * KiB);
    expect(sysOf(conn, 'sys.slow_down')[0]?.['p']).toEqual({
      for_ms: SLOW_DOWN_FOR_MS,
      reason: 'outbound',
    });
    expect(u.timers.pending.some((t) => t.ms === 5_000 && t.live)).toBe(true);
    // Still not drained at 5 s: closed after the jitter (here 250 ms, at most 500).
    conn.drain(256 * KiB);
    u.fire(5_000);
    expect(conn.closedWith).toBeNull();
    u.fire(250);
    expect(conn.closedWith).toBe(4429);
    expect(sysOf(conn, 'sys.error').at(-1)?.['p']).toMatchObject({ code: 'slow_consumer' });
    expect(u.recorded.count('relay_backpressure_closed_total', { reason: 'grace' })).toBe(1);
  });

  it('never drops a sequenced frame: every one is queued, in order, whatever the buffer', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 60; seq += 1)
      expect(u.send(conn, frameText(u.sid, seq))).toBe('queued');
    expect(conn.seqs()).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });
});

describe('a client that drains in time (acceptance 2)', () => {
  it('is not closed, and gets every frame in order', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 25; seq += 1) u.send(conn, frameText(u.sid, seq));
    expect(sysOf(conn, 'sys.slow_down')).toHaveLength(1);
    // It reads again: under 1 MiB within the grace.
    conn.drain(conn.buffered - 512 * KiB);
    u.controller.sweep();
    expect(u.timers.pending.some((t) => t.ms === 5_000 && t.live)).toBe(false);
    u.fire(5_000);
    u.fire(250);
    expect(conn.closedWith).toBeNull();
    for (let seq = 26; seq <= 30; seq += 1) u.send(conn, frameText(u.sid, seq));
    expect(conn.seqs()).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(u.recorded.count('relay_backpressure_recovered_total')).toBe(1);
  });

  it('a buffer under 1 MiB only when the grace ends is recovered too', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 25; seq += 1) u.send(conn, frameText(u.sid, seq));
    conn.drain();
    u.fire(5_000);
    u.fire(250);
    expect(conn.closedWith).toBeNull();
  });

  it('between the marks (1-2 MiB) at the end of the grace is still too slow', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 25; seq += 1) u.send(conn, frameText(u.sid, seq));
    conn.buffered = MiB + 200 * KiB;
    u.controller.sweep();
    u.fire(5_000);
    u.fire(250);
    expect(conn.closedWith).toBe(4429);
  });
});

describe('timers', () => {
  it('clears the grace and close timers when the connection closes', () => {
    const u = controllerUnit();
    const conn = u.connect();
    for (let seq = 1; seq <= 25; seq += 1) u.send(conn, frameText(u.sid, seq));
    const grace = u.timers.pending.find((t) => t.ms === 5_000 && t.live);
    conn.close(1000 as never);
    expect(grace?.live).toBe(false);
    expect(u.controller.isPaused(conn)).toBe(true);
  });

  it('whenDrained resolves once under 1 MiB, or when the connection closes', async () => {
    const u = controllerUnit();
    const conn = u.connect();
    await expect(u.controller.whenDrained(conn)).resolves.toBeUndefined();
    for (let seq = 1; seq <= 25; seq += 1) u.send(conn, frameText(u.sid, seq));
    let drained = false;
    void u.controller.whenDrained(conn).then(() => (drained = true));
    u.controller.sweep();
    await Promise.resolve();
    expect(drained).toBe(false);
    conn.drain();
    u.controller.onDrain(conn);
    await Promise.resolve();
    expect(drained).toBe(true);
    for (let seq = 26; seq <= 50; seq += 1) u.send(conn, frameText(u.sid, seq));
    const waiting = u.controller.whenDrained(conn);
    conn.close(1000 as never);
    await expect(waiting).resolves.toBeUndefined();
  });
});
