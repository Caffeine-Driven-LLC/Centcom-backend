/**
 * Fault injection (B011): middleware between a SimClient's socket and its protocol layer, applied
 * to every inbound frame in order: drop, duplicate, delay or reorder frames, or cut the connection
 * after a number of frames. Outbound faults (malformed JSON, oversize frames, frames before hello,
 * server-owned fields, a stalled socket) are SimClient methods: `sendRaw`, `sendFrame` with
 * `allowServerFields`, `connect({sendHello: false})`, `stall()`.
 *
 * Owns: perturbing what a client receives. A fault keeps its state for the client's lifetime, so
 * `disconnectAfter` fires once even across reconnects.
 */
import type { Clock } from './clock.js';

/** What a fault may use besides the frame. */
export interface FaultContext {
  readonly clock: Clock;
  /** Uniform in [0, 1); the client's (seedable) source. */
  readonly random: () => number;
  /** Ends the connection: 1006 drops it without a close frame, any other code closes it with that code. */
  disconnect(code: number): void;
}

/**
 * One inbound fault: receives the raw frame text and passes it on with `next` (zero, one or more
 * times, now or later).
 */
export type Fault = (data: string, next: (data: string) => void, ctx: FaultContext) => void;

/** Composes faults, first one outermost, ending in `sink`. */
export function applyFaults(
  list: readonly Fault[],
  sink: (data: string) => void,
  ctx: FaultContext,
): (data: string) => void {
  return list.reduceRight<(data: string) => void>(
    (next, fault) => (data) => fault(data, next, ctx),
    sink,
  );
}

const checkProbability = (name: string, p: number): void => {
  if (!(p >= 0 && p <= 1))
    throw new RangeError(`faults.${name}: ${p} is not a probability in [0, 1]`);
};

const checkCount = (name: string, n: number, min: number): void => {
  if (!Number.isInteger(n) || n < min)
    throw new RangeError(`faults.${name}: ${n} is not an integer of at least ${min}`);
};

/** A partly filled reorder window is released after this long. */
export const REORDER_FLUSH_MS = 20;

/** The built-in faults. */
export const faults = {
  /** Drops each frame with probability `p`. */
  drop(p: number): Fault {
    checkProbability('drop', p);
    return (data, next, ctx) => {
      if (p === 0 || ctx.random() >= p) next(data);
    };
  },

  /** Delivers each frame twice with probability `p`. */
  duplicate(p: number): Fault {
    checkProbability('duplicate', p);
    return (data, next, ctx) => {
      next(data);
      if (p > 0 && ctx.random() < p) next(data);
    };
  },

  /** Delivers each frame `ms` later (on the client's clock), in order. */
  delay(ms: number): Fault {
    if (!(ms >= 0 && Number.isFinite(ms)))
      throw new RangeError(`faults.delay: ${ms} is not a duration`);
    return (data, next, ctx) => {
      ctx.clock.setTimeout(() => next(data), ms);
    };
  },

  /**
   * Holds frames until `window` have arrived, then delivers them shuffled; a partly filled window
   * goes out after REORDER_FLUSH_MS.
   */
  reorder(window: number): Fault {
    checkCount('reorder', window, 2);
    let held: string[] = [];
    let timer: unknown;
    return (data, next, ctx) => {
      const flush = (): void => {
        ctx.clock.clearTimeout(timer);
        timer = undefined;
        const batch = held;
        held = [];
        for (let i = batch.length - 1; i > 0; i--) {
          const j = Math.floor(ctx.random() * (i + 1));
          [batch[i], batch[j]] = [batch[j] as string, batch[i] as string];
        }
        for (const frame of batch) next(frame);
      };
      held.push(data);
      if (held.length >= window) flush();
      else timer ??= ctx.clock.setTimeout(flush, REORDER_FLUSH_MS);
    };
  },

  /**
   * Passes `n` frames, then ends the connection with `code` (1006: dropped without a close frame,
   * as a network failure looks; otherwise a close frame with that code, 1000 or 3000-4999). Fires
   * once per client.
   */
  disconnectAfter(n: number, code: number): Fault {
    checkCount('disconnectAfter', n, 1);
    if (code !== 1006 && code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw new RangeError(
        `faults.disconnectAfter: a client cannot close with ${code} (use 1000, 1006 or 3000-4999)`,
      );
    }
    let seen = 0;
    let fired = false;
    return (data, next, ctx) => {
      // After firing, frames pass: the client ignores what the cut connection still delivers.
      if (fired) {
        next(data);
        return;
      }
      seen += 1;
      next(data);
      if (seen >= n) {
        fired = true;
        ctx.disconnect(code);
      }
    };
  },
} as const;
