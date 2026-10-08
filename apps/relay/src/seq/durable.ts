/**
 * The durable append (B041): once a frame is in the hot buffer it is handed to the `DurableAppend`
 * port (B042 wires B055's history store; until then the port keeps nothing), without waiting, so
 * delivery never depends on it. An append that rejects, or has not settled after
 * DURABLE_ATTEMPT_TIMEOUT_MS, counts `relay_durable_append_failed_total` and is retried up to
 * DURABLE_RETRIES times, after DURABLE_BASE_DELAY_MS doubling (capped at
 * DURABLE_MAX_DELAY_MS) with jitter; then it is given up (`relay_durable_append_given_up_total`,
 * `relay.durable_append_gave_up`). The frame stays replayable from the hot buffer meanwhile. At most
 * DURABLE_MAX_PENDING frames wait for the port; past that new ones are given up at once.
 *
 * Owns: the retries. Must not: block delivery, keep an unbounded backlog, or log a frame.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { DurableAppend, StoredFrame } from './types.js';

/** Retries after the first attempt. */
export const DURABLE_RETRIES = 5;
/** The first retry waits about this long (half of it fixed, half jitter); each later one twice. */
export const DURABLE_BASE_DELAY_MS = 250;
/** No retry waits longer. */
export const DURABLE_MAX_DELAY_MS = 10_000;
/** An attempt that has not settled after this long counts as failed (its result is ignored). */
export const DURABLE_ATTEMPT_TIMEOUT_MS = 10_000;
/** Frames in flight or waiting for a retry, at most. */
export const DURABLE_MAX_PENDING = 10_000;

/** The metric names. */
export const DURABLE_FAILED_METRIC = 'relay_durable_append_failed_total';
export const DURABLE_GIVEN_UP_METRIC = 'relay_durable_append_given_up_total';

/** The port until B042 wires one: keeps nothing. */
export const noDurableAppend: DurableAppend = Object.freeze({
  append: () => Promise.resolve(),
});

/** Dependencies of the appender. */
export interface DurableAppenderDeps {
  /** Default noDurableAppend. */
  port?: DurableAppend;
  metrics?: Metrics;
  logger?: Logger;
  /** Runs `fn` after `ms`; returns a canceller. Default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** [0, 1); default Math.random (jitter only). */
  random?: () => number;
  /** Default DURABLE_MAX_PENDING. */
  maxPending?: number;
}

/** Hands frames to the port. */
export interface DurableAppender {
  /** Appends `frame` of `sid` in the background. */
  append(sid: string, frame: StoredFrame): void;
  /** Replaces the port (frames already in flight keep the old one). */
  setPort(port: DurableAppend): void;
  /** Frames in flight or waiting for a retry. */
  pending(): number;
  /** Cancels the waiting retries; later appends are ignored. */
  stop(): void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/** The delay before retry `n` (1-based). */
export function retryDelayMs(n: number, random: () => number): number {
  const ceiling = Math.min(DURABLE_MAX_DELAY_MS, DURABLE_BASE_DELAY_MS * 2 ** (n - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** An appender over `deps.port`. */
export function createDurableAppender(deps: DurableAppenderDeps = {}): DurableAppender {
  const metrics = deps.metrics ?? noopMetrics;
  const setTimer = deps.setTimer ?? defaultTimer;
  const random = deps.random ?? Math.random;
  const maxPending = deps.maxPending ?? DURABLE_MAX_PENDING;
  let port = deps.port ?? noDurableAppend;
  let pending = 0;
  let stopped = false;
  const waiting = new Set<() => void>();

  const giveUp = (frame: StoredFrame, attempts: number, reason: string): void => {
    metrics.counter(DURABLE_GIVEN_UP_METRIC).inc();
    deps.logger?.warn({ seq: frame.seq, attempts, reason }, 'relay.durable_append_gave_up');
  };

  const attempt = (target: DurableAppend, sid: string, frame: StoredFrame, n: number): void => {
    let call: Promise<void>;
    try {
      call = target.append(sid, frame);
    } catch (err) {
      call = Promise.reject(err instanceof Error ? err : new Error('append threw'));
    }
    let settled = false;
    const failed = (): void => {
      metrics.counter(DURABLE_FAILED_METRIC).inc();
      if (stopped || n >= DURABLE_RETRIES) {
        pending -= 1;
        giveUp(frame, n + 1, stopped ? 'stopped' : 'retries');
        return;
      }
      const cancel = setTimer(
        () => {
          waiting.delete(cancel);
          attempt(target, sid, frame, n + 1);
        },
        retryDelayMs(n + 1, random),
      );
      waiting.add(cancel);
    };
    const expire = setTimer(() => {
      if (settled) return;
      settled = true;
      failed();
    }, DURABLE_ATTEMPT_TIMEOUT_MS);
    call.then(
      () => {
        if (settled) return;
        settled = true;
        expire();
        pending -= 1;
      },
      () => {
        if (settled) return;
        settled = true;
        expire();
        failed();
      },
    );
  };

  return {
    append(sid, frame) {
      if (stopped) return;
      if (pending >= maxPending) {
        giveUp(frame, 0, 'backlog');
        return;
      }
      pending += 1;
      attempt(port, sid, frame, 0);
    },
    setPort(next) {
      port = next;
    },
    pending: () => pending,
    stop() {
      stopped = true;
      for (const cancel of waiting) {
        cancel();
        pending -= 1;
      }
      waiting.clear();
    },
  };
}
