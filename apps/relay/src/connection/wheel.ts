/**
 * A hashed timer wheel (B040): every heartbeat deadline of the node on one platform timer, never
 * one timer per socket. Time is cut into slots of `resolutionMs`; an entry due at `at` lands in
 * the slot `ceil(at / resolutionMs)` and runs at the first tick at or after `at` (at most one
 * slot late). The one timer is set for the earliest occupied slot; with no entry, no timer runs.
 *
 * A tick runs every occupied slot that is due, oldest first (within a slot, entries run in the order
 * they were scheduled), so a late tick (a stalled event loop)
 * catches up instead of skipping. It tells each entry how late it ran (`lagMs`), which the
 * heartbeat uses to hold dead-peer checks after a stall.
 *
 * Owns: slots and the one timer. Must not: hold an entry after it ran or was cancelled.
 */

/** Runs `fn` after `ms`; returns a canceller. */
export type PlatformTimer = (fn: () => void, ms: number) => () => void;

/** A waiting entry; `cancel()` it to drop it. */
export interface WheelEntry {
  readonly at: number;
  cancel(): void;
}

/** What a tick passes to each entry it runs. */
export interface TickInfo {
  /** The tick's time (ms). */
  now: number;
  /** How far behind its schedule the tick ran (ms; 0 when on time or run by hand). */
  lagMs: number;
}

/** Options for TimerWheel. */
export interface TimerWheelOptions {
  /** Milliseconds since the epoch. */
  clock: () => number;
  /** Default: an unref'd setTimeout. */
  setTimer?: PlatformTimer;
  /** Slot width (ms); default 100. */
  resolutionMs?: number;
}

/** The default slot width. */
export const WHEEL_RESOLUTION_MS = 100;

const defaultTimer: PlatformTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

interface Slotted extends WheelEntry {
  readonly slot: number;
  readonly fn: (info: TickInfo) => void;
  /** Set by cancel(): an entry cancelled by another one of its own tick does not run. */
  cancelled: boolean;
}

/** The wheel. */
export class TimerWheel {
  readonly resolutionMs: number;
  readonly #clock: () => number;
  readonly #setTimer: PlatformTimer;
  readonly #slots = new Map<number, Set<Slotted>>();
  #size = 0;
  /** The last slot a tick ran; nothing is scheduled at or before it. */
  #ranThrough: number;
  #timer: { slot: number; cancel: () => void } | undefined;
  #ticking = false;

  constructor(options: TimerWheelOptions) {
    this.resolutionMs = options.resolutionMs ?? WHEEL_RESOLUTION_MS;
    if (!Number.isInteger(this.resolutionMs) || this.resolutionMs < 1) {
      throw new TypeError('TimerWheel: resolutionMs must be a positive integer');
    }
    this.#clock = options.clock;
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#ranThrough = Math.floor(this.#clock() / this.resolutionMs);
  }

  /** Entries waiting. */
  get size(): number {
    return this.#size;
  }

  /** Platform timers armed: 0 or 1. */
  get timers(): number {
    return this.#timer === undefined ? 0 : 1;
  }

  /** Runs `fn` at the first tick at or after `at` (ms since the epoch). */
  schedule(at: number, fn: (info: TickInfo) => void): WheelEntry {
    const slot = Math.max(Math.ceil(at / this.resolutionMs), this.#ranThrough + 1);
    const entry: Slotted = { at, slot, fn, cancelled: false, cancel: () => this.#remove(entry) };
    let set = this.#slots.get(slot);
    if (set === undefined) {
      set = new Set();
      this.#slots.set(slot, set);
    }
    set.add(entry);
    this.#size += 1;
    this.#armAt(slot);
    return entry;
  }

  /** Cancels every entry and the timer. */
  clear(): void {
    this.#slots.clear();
    this.#size = 0;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  /**
   * Runs every occupied slot that is due, oldest first. The timer calls it with the time it was
   * set for (to measure lag); tests may call it by hand.
   */
  tick(expectedAt?: number): void {
    if (this.#ticking) return;
    this.#ticking = true;
    this.#timer?.cancel();
    this.#timer = undefined;
    try {
      const now = this.#clock();
      const current = Math.floor(now / this.resolutionMs);
      const lagMs = expectedAt === undefined ? 0 : Math.max(0, now - expectedAt);
      const due = [...this.#slots.keys()].filter((s) => s <= current).sort((a, b) => a - b);
      for (const slot of due) this.#run(slot, { now, lagMs });
      this.#ranThrough = Math.max(this.#ranThrough, current);
    } finally {
      this.#ticking = false;
    }
    this.#arm();
  }

  #run(slot: number, info: TickInfo): void {
    const set = this.#slots.get(slot);
    if (set === undefined) return;
    this.#slots.delete(slot);
    this.#size -= set.size;
    for (const entry of set) if (!entry.cancelled) entry.fn(info);
  }

  #remove(entry: Slotted): void {
    entry.cancelled = true;
    const set = this.#slots.get(entry.slot);
    if (set === undefined || !set.delete(entry)) return;
    this.#size -= 1;
    if (set.size === 0) this.#slots.delete(entry.slot);
    if (this.#size === 0) {
      this.#timer?.cancel();
      this.#timer = undefined;
    }
  }

  /** Sets the timer for the earliest occupied slot, or clears it when nothing waits. */
  #arm(): void {
    if (this.#size === 0) {
      this.#timer?.cancel();
      this.#timer = undefined;
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const slot of this.#slots.keys()) if (slot < earliest) earliest = slot;
    this.#armAt(earliest);
  }

  /** Makes sure the timer fires by `slot` (outside a tick, which arms once at its end). */
  #armAt(slot: number): void {
    if (this.#ticking) return;
    if (this.#timer !== undefined && this.#timer.slot <= slot) return;
    this.#timer?.cancel();
    const at = slot * this.resolutionMs;
    this.#timer = {
      slot,
      cancel: this.#setTimer(() => this.tick(at), Math.max(0, at - this.#clock())),
    };
  }
}
