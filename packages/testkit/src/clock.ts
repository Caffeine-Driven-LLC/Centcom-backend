/**
 * Fake clock (B010): time that moves only when a test moves it. Pass `clock.now` wherever code
 * takes a clock (`createIdGenerator`, `createMemoryRedis`, a plugin's `clock` option).
 *
 * Owns: the fake time. Must not: read the real clock after creation, or accept a time that is
 * not a finite number.
 */

/** Where a new fake clock starts. */
export const DEFAULT_FAKE_TIME = '2026-01-01T00:00:00.000Z';

/** A clock under the test's control. */
export interface FakeClock {
  /** Milliseconds since the epoch. A plain function, safe to pass around unbound. */
  readonly now: () => number;
  /** Moves time by `ms` (forward, or back for a negative value). */
  advance(ms: number): void;
  /** Jumps to an ISO 8601 time. */
  set(iso: string): void;
  /** The current time as a Date. */
  date(): Date;
}

function parse(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`not an ISO 8601 time: ${JSON.stringify(iso)}`);
  return ms;
}

/** A fake clock starting at `startIso` (default DEFAULT_FAKE_TIME). */
export function createFakeClock(startIso: string = DEFAULT_FAKE_TIME): FakeClock {
  let current = parse(startIso);
  return {
    now: () => current,
    advance(ms: number): void {
      if (!Number.isFinite(ms))
        throw new RangeError('advance takes a finite number of milliseconds');
      current += ms;
    },
    set(iso: string): void {
      current = parse(iso);
    },
    date: () => new Date(current),
  };
}
