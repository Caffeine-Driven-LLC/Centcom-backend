/**
 * The timer wheel (B040): entries run at the first tick at or after their time, in time order
 * (within one slot, in the order scheduled);
 * cancelled ones never run (also when cancelled by an entry of the same tick); one platform timer
 * at most, none when empty; a late tick catches up on every slot it missed and reports its lag.
 */
import { describe, expect, it } from 'vitest';
import { TimerWheel } from '../../src/connection/wheel.js';
import { manualTimers } from './helpers.js';

function rig(resolutionMs = 100) {
  const timers = manualTimers();
  const wheel = new TimerWheel({
    clock: timers.clock.now,
    setTimer: timers.setTimer,
    resolutionMs,
  });
  const t0 = timers.clock.now();
  return { timers, wheel, t0 };
}

describe('TimerWheel', () => {
  it('runs entries at the first slot at or after their time, in order', () => {
    const { timers, wheel, t0 } = rig();
    const ran: [string, number][] = [];
    const at = (name: string) => () => ran.push([name, timers.clock.now() - t0]);
    wheel.schedule(t0 + 250, at('b'));
    wheel.schedule(t0 + 100, at('a'));
    wheel.schedule(t0 + 1_000, at('c'));
    expect(wheel.size).toBe(3);
    timers.clock.advance(2_000);
    expect(ran).toEqual([
      ['a', 100],
      ['b', 300],
      ['c', 1_000],
    ]);
    expect(wheel.size).toBe(0);
  });

  it('runs an entry due in the past at the next slot', () => {
    const { timers, wheel, t0 } = rig();
    let ranAt = -1;
    wheel.schedule(t0 - 5_000, () => (ranAt = timers.clock.now() - t0));
    timers.clock.advance(1_000);
    expect(ranAt).toBe(100);
  });

  it('never runs a cancelled entry, even one cancelled by another of its tick', () => {
    const { timers, wheel, t0 } = rig();
    const ran: string[] = [];
    // Both land in the 200 ms slot; within a slot, entries run in the order they were scheduled.
    const holder: { later?: { cancel(): void } } = {};
    wheel.schedule(t0 + 120, () => {
      ran.push('first');
      holder.later?.cancel();
    });
    holder.later = wheel.schedule(t0 + 150, () => ran.push('later'));
    const dropped = wheel.schedule(t0 + 500, () => ran.push('dropped'));
    dropped.cancel();
    dropped.cancel();
    timers.clock.advance(1_000);
    expect(ran).toEqual(['first']);
    expect(wheel.size).toBe(0);
  });

  it('keeps one platform timer while entries wait, and none when empty', () => {
    const { timers, wheel, t0 } = rig();
    expect(wheel.timers).toBe(0);
    const entries = Array.from({ length: 1_000 }, (_, i) =>
      wheel.schedule(t0 + 100 + i * 37, () => undefined),
    );
    expect(wheel.timers).toBe(1);
    expect(timers.armed()).toBe(1);
    for (const e of entries.slice(0, 500)) e.cancel();
    timers.clock.advance(10_000);
    expect(timers.maxArmed()).toBe(1);
    timers.clock.advance(40_000);
    expect(wheel.size).toBe(0);
    expect(wheel.timers).toBe(0);
    expect(timers.armed()).toBe(0);
  });

  it('arms its timer for the earliest entry, not every slot', () => {
    const { timers, wheel, t0 } = rig();
    let fired = 0;
    const count = timers.setTimer;
    const counting = new TimerWheel({
      clock: timers.clock.now,
      setTimer: (fn, ms) => {
        fired += 1;
        return count(fn, ms);
      },
    });
    counting.schedule(t0 + 20_000, () => undefined);
    timers.clock.advance(25_000);
    expect(fired).toBe(1);
    expect(wheel.size).toBe(0);
  });

  it('catches up on every slot a late tick missed, oldest first, and reports the lag', () => {
    let now = 1_000_000;
    let fire: (() => void) | undefined;
    const wheel = new TimerWheel({
      clock: () => now,
      setTimer: (fn) => {
        fire = fn;
        return () => (fire = undefined);
      },
    });
    const ran: [number, number][] = [];
    for (const offset of [100, 300, 5_000]) {
      wheel.schedule(now + offset, (info) => ran.push([offset, info.lagMs]));
    }
    now += 7_000;
    fire?.();
    expect(ran).toEqual([
      [100, 6_900],
      [300, 6_900],
      [5_000, 6_900],
    ]);
  });

  it('can be ticked by hand (lag 0) and cleared', () => {
    let now = 0;
    const wheel = new TimerWheel({ clock: () => now, setTimer: () => () => undefined });
    const lags: number[] = [];
    wheel.schedule(50, (info) => lags.push(info.lagMs));
    wheel.schedule(60_000, () => lags.push(-1));
    now = 200;
    wheel.tick();
    expect(lags).toEqual([0]);
    wheel.clear();
    now = 100_000;
    wheel.tick();
    expect(lags).toEqual([0]);
    expect(wheel.size).toBe(0);
  });

  it('refuses a resolution that is not a positive integer', () => {
    expect(() => new TimerWheel({ clock: () => 0, resolutionMs: 0 })).toThrow(TypeError);
    expect(() => new TimerWheel({ clock: () => 0, resolutionMs: 1.5 })).toThrow(TypeError);
  });
});
