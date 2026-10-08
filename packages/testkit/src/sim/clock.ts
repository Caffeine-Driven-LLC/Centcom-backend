/**
 * Time for the simulator and the loopback relay (B011): the current time and one-shot timers, so
 * tests drive heartbeats, the ack cadence and the handshake timeout without waiting for them.
 * `systemClock` uses the global timers (unref'd, so a forgotten timer never holds a test process
 * open); `createManualClock` runs timers only when the test advances it.
 *
 * Owns: protocol time. Waits for frames are bounded by real time instead (client.ts), so a hung
 * relay fails a test even while a manual clock stands still.
 */
import { DEFAULT_FAKE_TIME } from '../clock.js';

/** Time and timers, injected into SimClient and LoopbackRelay. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Runs `fn` once after `ms`; returns a handle for `clearTimeout`. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancels a timer; unknown or spent handles are ignored. */
  clearTimeout(handle: unknown): void;
}

/** Real time and real timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A clock that moves only when told. */
export interface ManualClock extends Clock {
  /** Moves time forward by `ms`, running every timer that falls due on the way, in due order. */
  advance(ms: number): void;
  /** How many timers are waiting. */
  pending(): number;
}

interface ManualTimer {
  due: number;
  fn: () => void;
}

/** A manual clock starting at `start` (epoch ms or ISO 8601; default 2026-01-01T00:00:00.000Z). */
export function createManualClock(start: number | string = DEFAULT_FAKE_TIME): ManualClock {
  let current = typeof start === 'string' ? Date.parse(start) : start;
  if (!Number.isFinite(current))
    throw new RangeError(`createManualClock: ${String(start)} is not a time`);
  let nextHandle = 1;
  // Handles grow, so map order is creation order: equal due times run in the order they were set.
  const timers = new Map<number, ManualTimer>();
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { due: current + Math.max(0, ms), fn });
      return handle;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') timers.delete(handle);
    },
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ${ms} is not a duration`);
      const target = current + ms;
      for (;;) {
        let next: [number, ManualTimer] | undefined;
        for (const entry of timers) {
          if (entry[1].due <= target && (next === undefined || entry[1].due < next[1].due))
            next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        current = next[1].due;
        next[1].fn();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}
