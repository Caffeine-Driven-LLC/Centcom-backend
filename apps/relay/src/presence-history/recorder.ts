/**
 * Presence history recording (B067, CT-WS-PRESENCE: "the relay derives offline when the socket
 * closes, after a 10 s grace to absorb reconnects").
 *
 * - **Online/offline** (`createConnectionEvents`): from this node's room joins and leaves, as B047's
 *   presence service decides it: a member's first connection here makes it online
 *   (`onConnected`); when its last one closes, it goes offline only if none comes back within
 *   RELAY_OFFLINE_GRACE_MS (10 s, B047's setting), and then `onDisconnected` gets the time the
 *   last connection closed and why (close code 4403: kicked; 1006 or a heartbeat timeout:
 *   timeout; anything else: closed). A reconnect within the grace writes nothing.
 * - **Last seen** (`touch`): a connection's activity, written at most once per TOUCH_EVERY_MS
 *   (60 s) per connection; the module also touches every connected member each minute.
 * - **Never on the hot path:** every call only buffers; the buffer is written every
 *   FLUSH_EVERY_MS (1 s) or at FLUSH_AT_EVENTS (200) online/offline events, after the call
 *   returns. Touches wait apart, the latest per member (bounded by the members connected here, so
 *   a minute's sweep never pushes events out). Database down: events wait (at most
 *   MAX_BUFFERED_EVENTS, 10 000; then the oldest are dropped and counted) and only the timer tries
 *   again, once a second; the relay is unaffected. A batch Postgres refuses (an integrity error:
 *   its session was deleted meanwhile) is dropped (counted), so it cannot block later writes.
 * - **Shutdown:** members still in their grace are written offline at once (`stop`), then flushed.
 * - **Out of order:** an offline event for a member not online here is ignored (debug log); the
 *   writer only moves last-seen forward.
 *
 * Owns: the grace, the throttle and the buffer. Must not: record a presence payload, or block a
 * connection.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  FLUSH_AT_EVENTS,
  FLUSH_EVERY_MS,
  MAX_BUFFERED_EVENTS,
  TOUCH_EVERY_MS,
  type ConnectedEvent,
  type DisconnectedEvent,
  type DisconnectReason,
  type HistoryEvent,
  type PresenceHistoryWriter,
} from './ports.js';

/** A cancellable timer. */
export interface HistoryTimer {
  cancel(): void;
}

const defaultTimer = (fn: () => void, ms: number): HistoryTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** What the recorder needs. */
export interface RecorderDeps {
  writer: PresenceHistoryWriter;
  logger?: Logger;
  metrics?: Metrics;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => HistoryTimer;
}

/** Buffers presence history and writes it in batches. */
export class PresenceHistoryRecorder {
  readonly #metrics: Metrics;
  readonly #setTimer: (fn: () => void, ms: number) => HistoryTimer;
  #buffer: HistoryEvent[] = [];
  #timer: HistoryTimer | undefined;
  #flushing: Promise<void> | undefined;
  /** The last write failed: only the timer tries again (no write per event during an outage). */
  #failing = false;
  /** A flush is queued for after the current call (at most one). */
  #queued = false;
  /** Members online here, per `sid/member`. */
  readonly #online = new Set<string>();
  /** When each connection (`sid/member/device`) was last touched. */
  readonly #touched = new Map<string, number>();
  /**
   * Touches waiting to be written: the latest per member (`sid/member`), outside the event buffer
   * and its cap (bounded by the members connected here), so a sweep never pushes events out.
   */
  #touches = new Map<string, HistoryEvent>();

  constructor(private readonly deps: RecorderDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#setTimer = deps.setTimer ?? defaultTimer;
  }

  /** Online/offline events waiting to be written. */
  get buffered(): number {
    return this.#buffer.length;
  }

  /** Members with a touch waiting to be written. */
  get pendingTouches(): number {
    return this.#touches.size;
  }

  onConnected(e: ConnectedEvent): void {
    this.#online.add(`${e.sid}/${e.memberId}`);
    this.#touched.set(`${e.sid}/${e.memberId}/${e.deviceId ?? ''}`, e.at.getTime());
    this.#metrics.counter('relay_presence_history_events_total', { event: 'connected' }).inc();
    this.#push({ kind: 'connected', ...e });
  }

  onDisconnected(e: DisconnectedEvent): void {
    const key = `${e.sid}/${e.memberId}`;
    if (!this.#online.delete(key)) {
      this.deps.logger?.debug({ sid: e.sid }, 'presence_history.out_of_order');
      return;
    }
    for (const touched of [...this.#touched.keys()]) {
      if (touched.startsWith(`${key}/`)) this.#touched.delete(touched);
    }
    // A pending touch is no newer than going offline.
    this.#touches.delete(key);
    this.#metrics.counter('relay_presence_history_events_total', { event: 'disconnected' }).inc();
    this.#push({ kind: 'disconnected', ...e });
  }

  /** Activity on a connection: last seen, at most once per TOUCH_EVERY_MS per connection. */
  touch(e: ConnectedEvent): void {
    if (!this.#online.has(`${e.sid}/${e.memberId}`)) return;
    const key = `${e.sid}/${e.memberId}/${e.deviceId ?? ''}`;
    const last = this.#touched.get(key);
    const at = e.at.getTime();
    if (last !== undefined && at - last < TOUCH_EVERY_MS) return;
    this.#touched.set(key, at);
    this.#touches.set(`${e.sid}/${e.memberId}`, { kind: 'touch', ...e });
    this.#schedule();
  }

  /**
   * Writes what is buffered (also at shutdown), after any write already running; never rejects.
   * A failed write keeps its events for the next flush.
   */
  async flush(): Promise<void> {
    this.#timer?.cancel();
    this.#timer = undefined;
    while (this.#flushing !== undefined) await this.#flushing;
    if (this.#buffer.length === 0 && this.#touches.size === 0) return;
    const events = this.#buffer;
    const touches = this.#touches;
    this.#buffer = [];
    this.#touches = new Map();
    this.#flushing = this.deps.writer
      .write([...events, ...touches.values()])
      .then(() => {
        this.#failing = false;
      })
      .catch((err: unknown) => {
        this.#metrics.counter('relay_presence_history_flush_failures_total').inc();
        this.deps.logger?.warn(
          { error: err instanceof Error ? err.name : 'unknown' },
          'presence_history.flush_failed',
        );
        if (isConstraintError(err)) {
          // Postgres refuses the batch itself (the writer skips deleted sessions, so this is a last
          // resort): retrying it would block every later write, so it goes (counted).
          this.#metrics
            .counter('relay_presence_history_dropped_total')
            .inc(events.length + touches.size);
          return;
        }
        // Kept for the next flush, ahead of what came meanwhile (a newer touch wins).
        this.#failing = true;
        this.#buffer = events.concat(this.#buffer);
        for (const [key, t] of touches) {
          // Only for members still online here (a newer touch wins; one who left has its offline).
          if (!this.#touches.has(key) && this.#online.has(key)) this.#touches.set(key, t);
        }
        this.#bound();
      })
      .finally(() => {
        this.#flushing = undefined;
        if (this.#buffer.length > 0 || this.#touches.size > 0) this.#schedule();
      });
    await this.#flushing;
  }

  #push(event: HistoryEvent): void {
    this.#buffer.push(event);
    this.#bound();
    if (
      this.#buffer.length >= FLUSH_AT_EVENTS &&
      !this.#failing &&
      this.#flushing === undefined &&
      !this.#queued
    ) {
      // After the caller returns: the call itself never starts the write.
      this.#queued = true;
      queueMicrotask(() => {
        this.#queued = false;
        void this.flush();
      });
    } else this.#schedule();
  }

  /** Keeps at most MAX_BUFFERED_EVENTS, dropping the oldest. */
  #bound(): void {
    const over = this.#buffer.length - MAX_BUFFERED_EVENTS;
    if (over <= 0) return;
    this.#buffer.splice(0, over);
    this.#metrics.counter('relay_presence_history_dropped_total').inc(over);
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#flushing !== undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.flush();
    }, FLUSH_EVERY_MS);
  }
}

/** A Postgres integrity error (SQLSTATE class 23): the data is refused, retrying cannot help. */
const isConstraintError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as { code?: unknown }).code === 'string' &&
  (err as { code: string }).code.startsWith('23');

/** The close code's reason (CT-WS-ENVELOPE close codes). */
export function reasonOf(code: number | undefined): DisconnectReason {
  if (code === 4403) return 'kicked';
  // 1006: the socket was cut (B040's heartbeat timeout terminates it).
  if (code === 1006) return 'timeout';
  return 'closed';
}

/** Turns this node's joins and leaves into online/offline events, with B047's grace. */
export function createConnectionEvents(deps: {
  recorder: Pick<PresenceHistoryRecorder, 'onConnected' | 'onDisconnected'>;
  graceMs: number;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => HistoryTimer;
}): {
  /** A connection of `memberId` joined here. */
  joined(sid: string, memberId: string, deviceId: string | null): void;
  /**
   * The member's last connection here closed; `code` reads its close code when the grace ends (the
   * room hears of the close before the code is passed on).
   */
  left(
    sid: string,
    memberId: string,
    deviceId: string | null,
    code: () => number | undefined,
  ): void;
  /**
   * Shutdown: every member still in its grace is written offline now, at the time its last
   * connection closed (the node will not see it come back).
   */
  stop(): void;
} {
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  /** Members online here, and the grace pending for those whose last connection closed. */
  const online = new Map<string, HistoryTimer | undefined>();
  /** The pending graces, with what each writes when it ends. */
  const graces = new Map<string, { timer: HistoryTimer; fire: () => void }>();
  return {
    joined(sid, memberId, deviceId) {
      const key = `${sid}/${memberId}`;
      if (online.has(key)) {
        // Back within the grace (or another connection): still online, nothing written.
        online.get(key)?.cancel();
        graces.delete(key);
        online.set(key, undefined);
        return;
      }
      online.set(key, undefined);
      deps.recorder.onConnected({ sid, memberId, deviceId, at: new Date(clock()) });
    },
    left(sid, memberId, deviceId, code) {
      const key = `${sid}/${memberId}`;
      if (!online.has(key)) return;
      const closedAt = clock();
      online.get(key)?.cancel();
      const fire = () => {
        online.delete(key);
        graces.delete(key);
        deps.recorder.onDisconnected({
          sid,
          memberId,
          deviceId,
          at: new Date(closedAt),
          reason: reasonOf(code()),
        });
      };
      const timer = setTimer(() => {
        if (online.get(key) === timer) fire();
      }, deps.graceMs);
      online.set(key, timer);
      graces.set(key, { timer, fire });
    },
    stop() {
      for (const [key, pending] of graces) {
        pending.timer.cancel();
        pending.fire();
        graces.delete(key);
      }
      online.clear();
    },
  };
}
