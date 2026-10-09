/**
 * The backpressure controller (B046, CT-WS-ENVELOPE "Limits": outbound buffer per connection
 * 2 MiB, exceeding it is `sys.slow_down`, then close 4429). Decisions use sizes only, never frame
 * content.
 *
 * - **Accounting:** a connection's buffered bytes are its socket's `bufferedAmount` (B037's
 *   `bufferedBytes`): every relay send goes straight to the socket, and B044's only queue (a
 *   replaying connection's hold) is capped by frames (10 000). A connection that cannot say
 *   counts as 0, logged once.
 * - **Policy** (`onEnqueue`, consulted by B044's `ConnectionSender` for every frame):
 *   - over the soft mark (1 MiB), a droppable frame (presence, cursors) is dropped and counted;
 *   - over the hard mark (2 MiB), the connection is told `sys.slow_down {for_ms: 2000, reason:
 *     "outbound"}` (written straight to the socket, at most once a second) and a grace timer
 *     starts (5 s). Back under the soft mark before it ends: recovered. Still over: `sys.error
 *     slow_consumer` and close 4429, 0-500 ms later (jitter, so a network event does not close
 *     everyone at once). The client resumes with `last_seq` (B042).
 *   - a sequenced frame is never dropped: it is queued, in order.
 * - **Drain:** a sweep (every 100 ms) re-reads pressured connections; `whenDrained(conn)` resolves
 *   once the connection is under the soft mark (or closed), for B042's replay.
 * - **Node guard:** the sweep adds every connection's buffered bytes. Over RELAY_NODE_BUFFER_MAX,
 *   the largest buffers are closed (4429) until the rest is under 90 % of it, and while the total
 *   is over the max the node is not ready (`/readyz` `buffers`; new connections refused).
 * - **Timers:** a connection's grace and close timers are cleared when it closes.
 *
 * Owns: per-connection pressure state, the sweep and the node total. Must not: drop a sequenced
 * frame, read a frame's content, or keep state for a closed connection.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import { closeConnection } from '../connection/close.js';
import type { ConnectionEntry } from '../connection-registry.js';
import { setOutboundPolicy, type OutboundPolicy } from '../fanout/fanout.js';
import type { RelayConnection } from '../pipeline.js';
import type { BackpressureConfig } from './config.js';

/** `sys.slow_down.p.for_ms` (card B046). */
export const SLOW_DOWN_FOR_MS = 2_000;
/** At most one `sys.slow_down` per connection this often. */
export const SLOW_DOWN_EVERY_MS = 1_000;
/** How often pressured connections and the node total are re-read. */
export const SWEEP_MS = 100;
/** Closes are spread over this much (ms) so many slow consumers do not reconnect at once. */
export const CLOSE_JITTER_MS = 500;
/** The node guard closes down to this share of RELAY_NODE_BUFFER_MAX. */
export const NODE_GUARD_TARGET = 0.9;
/** `relay_outbound_buffer_bytes` buckets. */
export const BUFFER_BUCKETS_BYTES: readonly number[] = Object.freeze([
  0, 16_384, 65_536, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304, 8_388_608,
]);

/** The details of the module's closes (GUIDELINES §3.4). */
export const BACKPRESSURE_DETAILS = Object.freeze({
  slow: 'The connection did not read what it was sent fast enough.',
  node: 'The relay is short of memory for outbound frames.',
} as const);

/** What the controller offers (card B046). */
export interface BackpressureController extends OutboundPolicy {
  /** A frame of `bytes` is about to be sent to `conn`: 'drop' only for a droppable one. */
  onEnqueue(conn: RelayConnection, bytes: number, droppable: boolean): 'ok' | 'drop';
  /** Re-reads `conn` now: recovered under the soft mark, waiters released. */
  onDrain(conn: RelayConnection): void;
  /** True while `conn` is over the hard mark. */
  isPaused(conn: RelayConnection): boolean;
  /** Resolves once `conn` is under the soft mark, or closed. */
  whenDrained(conn: RelayConnection): Promise<void>;
}

/** A timer that can be cancelled. */
export interface BackpressureTimer {
  cancel(): void;
}

/** What the controller needs. */
export interface BackpressureDeps {
  config: BackpressureConfig;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => BackpressureTimer;
  /** [0, 1), for the close jitter; default Math.random. */
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

interface ConnState {
  conn: RelayConnection;
  lastSlowDown: number;
  grace: BackpressureTimer | undefined;
  closing: BackpressureTimer | undefined;
  waiters: (() => void)[];
}

const defaultTimer = (fn: () => void, ms: number): BackpressureTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** The controller, with `attach` (each connection), the node state and `stop`. */
export function createBackpressure(deps: BackpressureDeps): BackpressureController & {
  attach(conn: RelayConnection): void;
  /** True while every connection's buffered bytes together are over RELAY_NODE_BUFFER_MAX. */
  overloaded(): boolean;
  /** Buffered bytes of every attached connection, at the last sweep. */
  total(): number;
  /** One sweep now (tests). */
  sweep(): void;
  stop(): void;
} {
  const { config } = deps;
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const random = deps.random ?? Math.random;
  const metrics = deps.metrics ?? noopMetrics;
  const bufferHistogram = metrics.histogram('relay_outbound_buffer_bytes', BUFFER_BUCKETS_BYTES);
  const states = new Map<ConnectionEntry, ConnState>();
  let warnedNoBuffer = false;
  let overloaded = false;
  let total = 0;
  let sweeps = 0;
  let sweepTimer: BackpressureTimer | undefined;
  let stopped = false;

  function bufferedOf(conn: RelayConnection): number {
    const read = conn.bufferedBytes;
    if (read === undefined) {
      if (!warnedNoBuffer) {
        warnedNoBuffer = true;
        deps.logger?.warn({}, 'relay.backpressure_no_buffer_info');
      }
      return 0;
    }
    return read.call(conn);
  }

  const isOpen = (conn: RelayConnection): boolean => conn.entry.state !== 'closing';

  function release(state: ConnState): void {
    for (const resolve of state.waiters.splice(0)) resolve();
  }

  function clear(state: ConnState): void {
    state.grace?.cancel();
    state.grace = undefined;
    state.closing?.cancel();
    state.closing = undefined;
    release(state);
  }

  /** Closes `conn` 4429 after a jittered pause (unless it closed meanwhile). */
  function closeSlow(state: ConnState, reason: 'grace' | 'node'): void {
    if (state.closing !== undefined) return;
    state.closing = setTimer(
      () => {
        state.closing = undefined;
        if (!isOpen(state.conn)) return;
        metrics.counter('relay_backpressure_closed_total', { reason }).inc();
        deps.logger?.info({ reason }, 'relay.slow_consumer_closed');
        closeConnection(state.conn, {
          code: CloseCode.RateLimited,
          errorCode: 'slow_consumer',
          detail: reason === 'node' ? BACKPRESSURE_DETAILS.node : BACKPRESSURE_DETAILS.slow,
        });
      },
      Math.floor(random() * CLOSE_JITTER_MS),
    );
  }

  /** Over the hard mark: tell the client (once a second at most) and start the grace. */
  function pressure(state: ConnState): void {
    const now = clock();
    if (now - state.lastSlowDown >= SLOW_DOWN_EVERY_MS) {
      state.lastSlowDown = now;
      metrics.counter('relay_backpressure_slow_downs_total').inc();
      // Straight to the socket: B044's sender (and this policy) is not in the way.
      state.conn.send({
        v: 1,
        t: 'sys.slow_down',
        p: { for_ms: SLOW_DOWN_FOR_MS, reason: 'outbound' },
      });
    }
    if (state.grace === undefined && state.closing === undefined) {
      metrics.counter('relay_backpressure_graces_total').inc();
      state.grace = setTimer(() => {
        state.grace = undefined;
        if (!isOpen(state.conn)) return;
        if (bufferedOf(state.conn) < config.softBytes) {
          recovered(state);
          return;
        }
        closeSlow(state, 'grace');
      }, config.graceMs);
    }
  }

  function recovered(state: ConnState): void {
    if (state.grace !== undefined) {
      state.grace.cancel();
      state.grace = undefined;
      metrics.counter('relay_backpressure_recovered_total').inc();
    }
    release(state);
  }

  function check(state: ConnState): number {
    const buffered = bufferedOf(state.conn);
    if (buffered < config.softBytes) recovered(state);
    return buffered;
  }

  function sweep(): void {
    sweeps += 1;
    let sum = 0;
    const sizes: [ConnState, number][] = [];
    const sample = sweeps % 10 === 0;
    for (const state of states.values()) {
      const buffered = check(state);
      sum += buffered;
      if (buffered > 0) {
        sizes.push([state, buffered]);
        if (sample) bufferHistogram.observe(buffered);
      }
    }
    total = sum;
    const wasOverloaded = overloaded;
    overloaded = sum > config.nodeMaxBytes;
    if (overloaded !== wasOverloaded) {
      deps.logger?.warn({ total: sum, max: config.nodeMaxBytes, overloaded }, 'relay.node_buffers');
    }
    if (overloaded) {
      // The largest first, until the rest is under 90 % of the cap.
      sizes.sort((a, b) => b[1] - a[1]);
      let rest = sum;
      for (const [state, buffered] of sizes) {
        if (rest <= config.nodeMaxBytes * NODE_GUARD_TARGET) break;
        if (state.closing !== undefined) {
          rest -= buffered;
          continue;
        }
        closeSlow(state, 'node');
        rest -= buffered;
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    sweepTimer = setTimer(() => {
      sweep();
      schedule();
    }, SWEEP_MS);
  }
  schedule();

  const controller = {
    attach(conn: RelayConnection) {
      const state: ConnState = {
        conn,
        lastSlowDown: Number.NEGATIVE_INFINITY,
        grace: undefined,
        closing: undefined,
        waiters: [],
      };
      states.set(conn.entry, state);
      setOutboundPolicy(conn, controller);
      conn.onClose(() => {
        clear(state);
        states.delete(conn.entry);
        setOutboundPolicy(conn, undefined);
      });
    },
    onEnqueue(conn: RelayConnection, bytes: number, droppable: boolean): 'ok' | 'drop' {
      const state = states.get(conn.entry);
      if (state === undefined) return 'ok';
      const buffered = bufferedOf(conn);
      if (droppable && buffered + bytes > config.softBytes) {
        metrics.counter('relay_backpressure_dropped_total').inc();
        return 'drop';
      }
      if (buffered + bytes > config.hardBytes) pressure(state);
      return 'ok';
    },
    onDrain(conn: RelayConnection) {
      const state = states.get(conn.entry);
      if (state !== undefined) check(state);
    },
    isPaused: (conn: RelayConnection) => bufferedOf(conn) > config.hardBytes,
    whenDrained(conn: RelayConnection): Promise<void> {
      const state = states.get(conn.entry);
      if (state === undefined || !isOpen(conn) || bufferedOf(conn) < config.softBytes) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => state.waiters.push(resolve));
    },
    overloaded: () => overloaded,
    total: () => total,
    sweep,
    stop() {
      stopped = true;
      sweepTimer?.cancel();
      for (const state of states.values()) clear(state);
    },
  };
  return controller;
}
