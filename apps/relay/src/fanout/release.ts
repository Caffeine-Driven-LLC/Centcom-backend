/**
 * Ordered release (B044): hands a session's sequenced frames on strictly in contiguous `seq`
 * order, whatever order they are offered in.
 *
 * - The first frame offered for a session sets where it starts; on one node offers arrive in
 *   `seq` order (B041 resolves its store calls in order), so out-of-order offers come from other
 *   nodes (B045) or a lost offer.
 * - A frame after a missing one waits, up to `maxBuffered` (2 000) frames or `gapAfterMs` (250 ms)
 *   after the first one started waiting; then `onGap(sid, from, to)` reports the missing range
 *   and nothing past it is released until the gap is filled (`offer` of the missing frames) or
 *   the session is `reset`.
 * - A frame below the next expected `seq` (already released, or a duplicate) is ignored.
 * - A session idle for `idleMs` with nothing waiting is forgotten, so state stays as small as the
 *   set of active sessions; a pinned one (B045: it has local connections and gets frames from
 *   other nodes) never is.
 * - `prime(sid, next)` (B042) sets where a session with no state starts, instead of the first frame
 *   offered: with frames from several nodes the first one to arrive need not be the lowest.
 *
 * Owns: per-session order and the waiting frames. Must not: deliver past a gap, or hold more
 * than `maxBuffered` frames of a session.
 */
import type { StoredFrame } from '../seq/types.js';

/** Frames of one session that may wait for a missing one (card B044). */
export const RELEASE_MAX_BUFFERED = 2_000;
/** How long frames wait for a missing one before the gap is reported (card B044). */
export const RELEASE_GAP_AFTER_MS = 250;
/** A session with nothing waiting is forgotten after this long without an offer. */
export const RELEASE_IDLE_MS = 5 * 60 * 1000;

/** A timer that can be cancelled. */
export interface ReleaseTimer {
  cancel(): void;
}

/** B044's ordered release. */
export interface OrderedRelease {
  offer(sid: string, frame: StoredFrame): void;
  onGap(cb: (sid: string, fromSeq: number, toSeq: number) => void): void;
  /** Forgets the session: the next frame offered sets where it starts again. */
  reset(sid: string): void;
  /** The next `seq` the session expects, or null when it has no state. */
  expected(sid: string): number | null;
  /** A session with no state starts at `next` (the frame after the store's head); else nothing. */
  prime(sid: string, next: number): void;
  /** Keeps the session's state while pinned (never forgotten as idle). */
  pin(sid: string): void;
  unpin(sid: string): void;
  /** How long frames wait for a missing one from now on (B045: RELAY_CLUSTER_GAP_MS). */
  setGapAfterMs(ms: number): void;
  /** Frames waiting, over all sessions. */
  waiting(): number;
  /** Sessions with state. */
  sessions(): number;
  /** Cancels every timer. */
  stop(): void;
}

/** Options of `createOrderedRelease`. */
export interface OrderedReleaseOptions {
  /** Called for each frame, in order. */
  release(sid: string, frame: StoredFrame): void;
  maxBuffered?: number;
  gapAfterMs?: number;
  idleMs?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReleaseTimer;
}

interface SessionOrder {
  next: number;
  pending: Map<number, StoredFrame>;
  timer: ReleaseTimer | undefined;
  /** A gap was reported and is not resolved yet. */
  gapOpen: boolean;
  lastOffer: number;
}

const defaultTimer = (fn: () => void, ms: number): ReleaseTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** A new ordered release. */
export function createOrderedRelease(options: OrderedReleaseOptions): OrderedRelease {
  const maxBuffered = options.maxBuffered ?? RELEASE_MAX_BUFFERED;
  let gapAfterMs = options.gapAfterMs ?? RELEASE_GAP_AFTER_MS;
  const idleMs = options.idleMs ?? RELEASE_IDLE_MS;
  const clock = options.clock ?? Date.now;
  const setTimer = options.setTimer ?? defaultTimer;
  const states = new Map<string, SessionOrder>();
  const gapListeners: ((sid: string, fromSeq: number, toSeq: number) => void)[] = [];
  const pinned = new Set<string>();
  let waiting = 0;
  let offers = 0;

  function reportGap(sid: string, state: SessionOrder): void {
    state.timer?.cancel();
    state.timer = undefined;
    if (state.pending.size === 0 || state.gapOpen) return;
    state.gapOpen = true;
    const lowest = Math.min(...state.pending.keys());
    for (const cb of gapListeners) cb(sid, state.next, lowest - 1);
  }

  function drain(sid: string, state: SessionOrder): void {
    for (;;) {
      const frame = state.pending.get(state.next);
      if (frame === undefined) break;
      state.pending.delete(state.next);
      waiting -= 1;
      state.next += 1;
      state.gapOpen = false;
      options.release(sid, frame);
    }
    if (state.pending.size === 0) {
      state.timer?.cancel();
      state.timer = undefined;
      state.gapOpen = false;
    } else if (state.pending.size > maxBuffered) {
      reportGap(sid, state);
    } else if (state.timer === undefined && !state.gapOpen) {
      state.timer = setTimer(() => {
        state.timer = undefined;
        reportGap(sid, state);
      }, gapAfterMs);
    }
  }

  function forgetIdle(now: number): void {
    for (const [sid, state] of states) {
      if (state.pending.size === 0 && now - state.lastOffer > idleMs && !pinned.has(sid)) {
        states.delete(sid);
      }
    }
  }

  return {
    offer(sid, frame) {
      const now = clock();
      offers += 1;
      if (offers % 1_000 === 0) forgetIdle(now);
      let state = states.get(sid);
      if (state === undefined) {
        state = {
          next: frame.seq,
          pending: new Map(),
          timer: undefined,
          gapOpen: false,
          lastOffer: now,
        };
        states.set(sid, state);
      }
      state.lastOffer = now;
      if (frame.seq < state.next || state.pending.has(frame.seq)) return;
      state.pending.set(frame.seq, frame);
      waiting += 1;
      drain(sid, state);
    },
    onGap(cb) {
      gapListeners.push(cb);
    },
    reset(sid) {
      const state = states.get(sid);
      if (state === undefined) return;
      state.timer?.cancel();
      waiting -= state.pending.size;
      states.delete(sid);
    },
    expected: (sid) => states.get(sid)?.next ?? null,
    prime(sid, next) {
      if (states.has(sid) || !Number.isSafeInteger(next) || next < 1) return;
      states.set(sid, {
        next,
        pending: new Map(),
        timer: undefined,
        gapOpen: false,
        lastOffer: clock(),
      });
    },
    pin: (sid) => void pinned.add(sid),
    unpin: (sid) => void pinned.delete(sid),
    setGapAfterMs(ms) {
      if (Number.isSafeInteger(ms) && ms > 0) gapAfterMs = ms;
    },
    waiting: () => waiting,
    sessions: () => states.size,
    stop() {
      for (const state of states.values()) state.timer?.cancel();
    },
  };
}
