/**
 * The sequence stage (B041, pipeline order 40; CT-WS-ENVELOPE "Sequencing and delivery
 * guarantees"). For an authenticated connection's decoded frames:
 *
 * - `event`, `queue` and `control` frames spend a token of the member's bucket (`rate-limit.ts`;
 *   none left: dropped, `sys.slow_down {reason: "rate"}` at most once per second, and close 4429
 *   `frame_rate_exceeded` after 5 s of continuous excess). Then, in the connection's arrival
 *   order, the store assigns the `seq` atomically with the dedupe check and the buffer append;
 *   the frame gets the server's `from` (the connection's member), `ts` and `seq`, goes back to the
 *   sender as the echo that acknowledges its send, is handed to the durable append without
 *   waiting, and passes on to fan-out (B044) as `fc.state[SEQUENCED_STATE_KEY]`. A duplicate
 *   `(sid, from, id)` is echoed with its original `seq` and `ts` and goes no further. At most
 *   `maxQueued` (RELAY_SEQ_BURST) frames of a connection wait for the store; past that, and for
 *   UNAVAILABLE_PAUSE_MS after the store failed, frames are refused at once (503) instead of
 *   queued. A connection's frames still waiting when it closes are dropped (its client resends
 *   them after reconnecting, and the dedupe makes that safe).
 * - An `ack` (a `t: "ack"` frame, consumed here, or the field on any frame) moves the connection's
 *   `acked_seq` up; one beyond the session's head is `sys.error invalid_frame` (pointer `/ack`) and
 *   moves nothing; on a sequenced frame it also drops that frame; the 11th within 60 s closes
 *   4400. Acks never wait behind sequenced frames: an ack within the head this node has seen is
 *   taken at once, and per connection one ack at most waits for the store's head (later ones
 *   only raise the value it waits with).
 * - Store down: the frame is refused with `sys.error service_unavailable` (`retry_after_s`) and
 *   `sys.slow_down`, the connection stays, and nothing is sequenced locally.
 * - Everything else passes on untouched (`presence`, `sys.*`).
 *
 * Replies about one frame carry its `id` as `ref`. Logs carry outcomes and counts, never `p`,
 * `ct`, `sig` or ids.
 *
 * Owns: the stage, the per-connection order and its bound, the buckets and the ack checks. Must
 * not: deliver a frame before it is in the hot buffer, inspect `ct`, or queue a rate-limited
 * frame.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Logger, type Metrics } from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import { closeConnection, type CloseTimer } from '../connection/close.js';
import type { ConnectionEntry } from '../connection-registry.js';
import type { FrameContext, InboundStage, RelayConnection } from '../pipeline.js';
import { createAckTracker } from './acks.js';
import { createDurableAppender } from './durable.js';
import { stampFrame, withSeq, type SequencableFrame } from './frame.js';
import { MemberRateLimiter, SLOW_DOWN_MS, type RateDecision } from './rate-limit.js';
import {
  SEQUENCED_STATE_KEY,
  SEQUENCED_TYPES,
  type AssignResult,
  type DurableAppend,
  type SeqService,
  type SeqStore,
  type StoredFrame,
  type UnsequencedFrame,
} from './types.js';

/** Invalid acks a connection may send per window before it is closed 4400 (as the codec's frames). */
export const INVALID_ACKS_PER_WINDOW = 10;
export const INVALID_ACK_WINDOW_MS = 60_000;
/** After the store fails, sequenced frames are refused at once for this long (its `retry_after_s`). */
export const UNAVAILABLE_PAUSE_MS = 1_000;

/** The stage's metric names. */
export const SEQ_METRICS = Object.freeze({
  /** Sequenced frames by outcome: assigned, duplicate, rate_limited, unavailable, backlog. */
  sequenced: 'relay_sequenced_total',
  /** SeqStore.assign latency, milliseconds. */
  assignMs: 'relay_seq_assign_ms',
  /** Acks refused (beyond the head). */
  acksRejected: 'relay_acks_rejected_total',
} as const);

/** `relay_seq_assign_ms` buckets. */
export const ASSIGN_MS_BUCKETS: readonly number[] = Object.freeze([
  0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 1_000, 2_000,
]);

/** The details of the stage's refusals (GUIDELINES §3.4). */
export const SEQ_DETAILS = Object.freeze({
  ackBeyondHead: 'The ack is beyond the newest seq of this session.',
  missingId: 'Sequenced frames need an id and a kind.',
  unavailable: 'Sequencing is unavailable right now; send the frame again shortly.',
  backlog: 'Too many frames are waiting to be sequenced; send the frame again shortly.',
  rate: 'Too many sequenced frames for too long.',
  invalidBudget: 'Too many invalid frames.',
} as const);

/** Dependencies of the stage. */
export interface SequencerDeps {
  store: SeqStore;
  /** RELAY_SEQ_RATE. */
  rate: number;
  /** RELAY_SEQ_BURST. */
  burst: number;
  /** Sequenced frames of one connection that may wait for the store; default `burst`. */
  maxQueued?: number;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** A monotonic millisecond clock for latency; default performance.now. */
  monotonic?: () => number;
  /** Default: keeps nothing (`noDurableAppend`). */
  durable?: DurableAppend;
  logger?: Logger;
  metrics?: Metrics;
  /** Timers of the durable retries and time limits; default unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** The 1 s cut after a close (`closeConnection`); default unref'd setTimeout. */
  closeTimer?: CloseTimer;
  /** [0, 1), for retry jitter; default Math.random. */
  random?: () => number;
}

/** The stage and what goes with it. */
export interface Sequencer {
  stage: InboundStage;
  /** Forgets a connection's state when it closes. */
  onConnection(connection: RelayConnection): void;
  /** `ctx.seq`. */
  service: SeqService;
  /** What the stage holds (leak checks). */
  stats(): {
    connections: number;
    sessions: number;
    buckets: number;
    queued: number;
    durablePending: number;
  };
  /** Cancels the durable retries. */
  stop(): void;
}

interface ConnState {
  sid: string;
  member: string;
  bucket: string;
  chain: Promise<void>;
  /** Sequenced frames waiting in `chain` or being assigned. */
  queued: number;
  lastSlowDown: number | null;
  invalid: number[];
  /** The highest ack waiting for the store's head, or null when none waits. */
  ackWaiting: number | null;
}

interface SessionState {
  connections: number;
  /** The newest `seq` this node has seen for the session. */
  head: number;
  lookup: Promise<number> | null;
}

type AckCheck = 'ok' | 'invalid' | 'unknown';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAckValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const noop = (): void => undefined;

/** `sys.error` with `error`, about the frame `ref` when there is one. */
function sysError(error: AppError, ref: unknown): object {
  return {
    v: 1,
    t: 'sys.error',
    ...(typeof ref === 'string' ? { ref } : {}),
    p: toProblem(error, { requestId: newId('req') }),
  };
}

/** The sequence stage over `deps.store`. */
export function createSequencer(deps: SequencerDeps): Sequencer {
  const clock = deps.clock ?? Date.now;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const metrics = deps.metrics ?? noopMetrics;
  const closeOptions = deps.closeTimer === undefined ? {} : { setTimer: deps.closeTimer };
  const maxQueued = deps.maxQueued ?? deps.burst;
  const limiter = new MemberRateLimiter({ rate: deps.rate, burst: deps.burst });
  const acks = createAckTracker();
  const durable = createDurableAppender({
    ...(deps.durable === undefined ? {} : { port: deps.durable }),
    metrics,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });
  const assignMs = metrics.histogram(SEQ_METRICS.assignMs, ASSIGN_MS_BUCKETS);
  const states = new WeakMap<ConnectionEntry, ConnState>();
  const gone = new WeakSet<ConnectionEntry>();
  const sessions = new Map<string, SessionState>();
  let connections = 0;
  let queued = 0;
  /** Sequenced frames are refused at once until then (the store just failed). */
  let unavailableUntil = Number.NEGATIVE_INFINITY;
  let outage = false;
  /** Fan-out (B044) delivers new frames to their senders, in order; the stage echoes duplicates only. */
  let echoDelegated = false;

  const count = (outcome: string): void =>
    metrics.counter(SEQ_METRICS.sequenced, { outcome }).inc();

  function attach(entry: ConnectionEntry, sid: string, member: string, now: number): ConnState {
    const bucket = MemberRateLimiter.key(sid, member);
    const state: ConnState = {
      sid,
      member,
      bucket,
      chain: Promise.resolve(),
      queued: 0,
      lastSlowDown: null,
      invalid: [],
      ackWaiting: null,
    };
    states.set(entry, state);
    limiter.attach(bucket, now);
    acks.track(entry.id, sid);
    const session = sessions.get(sid) ?? { connections: 0, head: 0, lookup: null };
    session.connections += 1;
    sessions.set(sid, session);
    connections += 1;
    return state;
  }

  function detach(entry: ConnectionEntry): void {
    gone.add(entry);
    const state = states.get(entry);
    if (state === undefined) return;
    states.delete(entry);
    limiter.detach(state.bucket);
    acks.forget(entry.id);
    const session = sessions.get(state.sid);
    if (session !== undefined) {
      session.connections -= 1;
      if (session.connections <= 0) sessions.delete(state.sid);
    }
    connections -= 1;
  }

  /** Runs `task` after the connection's earlier frames: its frames keep their arrival order. */
  function serial(state: ConnState, task: () => Promise<void>): Promise<void> {
    const run = state.chain.then(task);
    state.chain = run.then(noop, noop);
    return run;
  }

  function slowDown(conn: RelayConnection, state: ConnState, now: number): void {
    if (state.lastSlowDown !== null && now - state.lastSlowDown < SLOW_DOWN_MS) return;
    state.lastSlowDown = now;
    conn.send({ v: 1, t: 'sys.slow_down', p: { for_ms: SLOW_DOWN_MS, reason: 'rate' } });
  }

  function rateLimited(
    conn: RelayConnection,
    state: ConnState,
    decision: Exclude<RateDecision, 'pass'>,
    now: number,
  ): void {
    count('rate_limited');
    if (decision === 'close') {
      deps.logger?.info({ close: CloseCode.RateLimited }, 'relay.seq_rate_closed');
      closeConnection(
        conn,
        { code: CloseCode.RateLimited, errorCode: 'frame_rate_exceeded', detail: SEQ_DETAILS.rate },
        closeOptions,
      );
      return;
    }
    slowDown(conn, state, now);
  }

  /** Refuses frame `ref` with a 503 the client retries (store down, or too many waiting). */
  function refuse(
    conn: RelayConnection,
    state: ConnState,
    ref: unknown,
    now: number,
    outcome: 'unavailable' | 'backlog',
  ): void {
    count(outcome);
    const detail = outcome === 'backlog' ? SEQ_DETAILS.backlog : SEQ_DETAILS.unavailable;
    conn.send(sysError(new AppError('service_unavailable', { detail, retryAfterS: 1 }), ref));
    slowDown(conn, state, now);
  }

  /** Counts an invalid frame; true when the connection was closed for it (the 11th in 60 s). */
  function spendInvalid(conn: RelayConnection, state: ConnState, now: number): boolean {
    state.invalid = state.invalid.filter((t) => now - t < INVALID_ACK_WINDOW_MS);
    state.invalid.push(now);
    if (state.invalid.length <= INVALID_ACKS_PER_WINDOW) return false;
    closeConnection(
      conn,
      {
        code: CloseCode.ProtocolViolation,
        errorCode: 'invalid_frame',
        detail: SEQ_DETAILS.invalidBudget,
      },
      closeOptions,
    );
    return true;
  }

  /** Refuses an ack beyond the head: `sys.error` (unless the budget closes the connection). */
  function rejectAck(conn: RelayConnection, state: ConnState, ref: unknown, now: number): void {
    metrics.counter(SEQ_METRICS.acksRejected).inc();
    if (spendInvalid(conn, state, now)) return;
    conn.send(
      sysError(
        new AppError('invalid_frame', {
          detail: SEQ_DETAILS.ackBeyondHead,
          errors: [{ pointer: '/ack', code: 'invalid', detail: 'is beyond the head' }],
        }),
        ref,
      ),
    );
  }

  /** The session's head, one lookup at a time per session. */
  function lookupHead(sid: string, session: SessionState): Promise<number> {
    if (session.lookup === null) {
      session.lookup = deps.store.head(sid).finally(() => {
        session.lookup = null;
      });
    }
    return session.lookup;
  }

  /** Raises the session's known head from the store; false when the store cannot say. */
  async function refreshHead(sid: string, session: SessionState): Promise<boolean> {
    try {
      session.head = Math.max(session.head, await lookupHead(sid, session));
      return true;
    } catch {
      return false;
    }
  }

  /** An ack on a sequenced frame, checked in the frame's turn: 'invalid' drops the frame. */
  async function checkAck(
    conn: RelayConnection,
    state: ConnState,
    value: unknown,
    ref: unknown,
    now: number,
  ): Promise<AckCheck> {
    const session = sessions.get(state.sid);
    if (!isAckValue(value)) return 'invalid';
    if (session === undefined) return 'unknown';
    // The head cannot be checked now: the ack is not recorded, the frame goes on.
    if (value > session.head && !(await refreshHead(state.sid, session))) return 'unknown';
    if (value > session.head) {
      rejectAck(conn, state, ref, now);
      return 'invalid';
    }
    acks.onAck(conn.entry.id, value);
    return 'ok';
  }

  /**
   * A pure ack or one on a frame that is not sequenced: never queued behind sequenced frames.
   * Within the known head it is taken at once; beyond it, one ack per connection waits for the
   * store's head and later ones only raise the value it waits with.
   */
  async function takeAck(conn: RelayConnection, state: ConnState, value: unknown): Promise<void> {
    const session = sessions.get(state.sid);
    if (!isAckValue(value) || session === undefined) return;
    if (value <= session.head) {
      acks.onAck(conn.entry.id, value);
      return;
    }
    if (state.ackWaiting !== null) {
      state.ackWaiting = Math.max(state.ackWaiting, value);
      return;
    }
    state.ackWaiting = value;
    const known = await refreshHead(state.sid, session);
    const waiting = state.ackWaiting;
    state.ackWaiting = null;
    if (!known || gone.has(conn.entry)) return;
    if (waiting <= session.head) acks.onAck(conn.entry.id, waiting);
    else rejectAck(conn, state, undefined, clock());
  }

  async function sequence(
    fc: FrameContext,
    next: () => Promise<void>,
    state: ConnState,
    frame: Record<string, unknown>,
    now: number,
  ): Promise<void> {
    const conn = fc.connection;
    const id = frame['id'];
    if (typeof id !== 'string' || typeof frame['k'] !== 'string') {
      conn.send(sysError(new AppError('invalid_frame', { detail: SEQ_DETAILS.missingId }), id));
      return;
    }
    if (clock() < unavailableUntil) {
      refuse(conn, state, id, now, 'unavailable');
      return;
    }
    const unsequenced = stampFrame(
      frame as unknown as SequencableFrame,
      state.member,
      new Date(now).toISOString(),
      state.sid,
    );
    const started = monotonic();
    let result: AssignResult;
    try {
      result = await deps.store.assign(state.sid, { from: state.member, id }, unsequenced, now);
    } catch (err) {
      unavailableUntil = clock() + UNAVAILABLE_PAUSE_MS;
      if (!outage) {
        outage = true;
        deps.logger?.warn(
          { error: err instanceof Error ? err.name : typeof err },
          'relay.seq_unavailable',
        );
      }
      refuse(conn, state, id, now, 'unavailable');
      return;
    }
    if (outage) {
      outage = false;
      deps.logger?.info({}, 'relay.seq_available');
    }
    assignMs.observe(monotonic() - started);
    const session = sessions.get(state.sid);
    if (session !== undefined && result.seq > session.head) session.head = result.seq;
    const stored: StoredFrame = withSeq(
      result.duplicate ? { ...unsequenced, ts: result.ts } : unsequenced,
      result.seq,
    );
    // The echo: the sender learns the frame's place (CT-WS-ENVELOPE), even for a resend. Once
    // fan-out delivers new frames to their senders too (in seq order), only resends are echoed here.
    if (result.duplicate || !echoDelegated) conn.send(stored);
    if (result.duplicate) {
      count('duplicate');
      return;
    }
    count('assigned');
    durable.append(state.sid, stored);
    fc.state[SEQUENCED_STATE_KEY] = stored;
    await next();
  }

  const stage: InboundStage = async (fc, next) => {
    const frame = fc.frame;
    const conn = fc.connection;
    const { entry } = conn;
    if (!isRecord(frame) || entry.sessionId === null || entry.memberId === null) {
      await next();
      return;
    }
    const closed = gone.has(entry) || entry.state === 'closing';
    const now = clock();
    // Every authenticated connection is tracked from its first frame (acks count it from then).
    const state = closed
      ? states.get(entry)
      : (states.get(entry) ?? attach(entry, entry.sessionId, entry.memberId, now));
    const t = frame['t'];
    if (!(typeof t === 'string' && SEQUENCED_TYPES.has(t))) {
      if (frame['ack'] !== undefined && !closed && state !== undefined) {
        // A pure ack waits for its check (it is consumed); any other frame goes on meanwhile.
        if (t === 'ack') await takeAck(conn, state, frame['ack']);
        else void takeAck(conn, state, frame['ack']);
      }
      if (t !== 'ack') await next();
      return;
    }
    if (closed || state === undefined) return;
    const decision = limiter.take(state.bucket, now);
    if (decision !== 'pass') {
      rateLimited(conn, state, decision, now);
      return;
    }
    if (now < unavailableUntil) {
      refuse(conn, state, frame['id'], now, 'unavailable');
      return;
    }
    if (state.queued >= maxQueued) {
      refuse(conn, state, frame['id'], now, 'backlog');
      return;
    }
    state.queued += 1;
    queued += 1;
    try {
      await serial(state, async () => {
        // Closed while it waited: dropped; the client resends it after reconnecting.
        if (gone.has(entry)) return;
        if (frame['ack'] !== undefined) {
          const checked = await checkAck(conn, state, frame['ack'], frame['id'], now);
          if (checked === 'invalid') return;
        }
        await sequence(fc, next, state, frame, now);
      });
    } finally {
      state.queued -= 1;
      queued -= 1;
    }
  };

  return {
    stage,
    onConnection(connection) {
      connection.onClose(() => detach(connection.entry));
    },
    service: Object.freeze({
      store: deps.store,
      acks,
      setDurableAppend: (port: DurableAppend) => durable.setPort(port),
      delegateEcho: () => {
        echoDelegated = true;
      },
      async submitServer(sid: string, frame: UnsequencedFrame): Promise<StoredFrame> {
        const result = await deps.store.assign(
          sid,
          { from: frame.from, id: frame.id },
          frame,
          clock(),
        );
        const session = sessions.get(sid);
        if (session !== undefined && result.seq > session.head) session.head = result.seq;
        const stored = withSeq(result.duplicate ? { ...frame, ts: result.ts } : frame, result.seq);
        if (!result.duplicate) {
          count('assigned');
          durable.append(sid, stored);
        }
        return stored;
      },
    }),
    stats: () => ({
      connections,
      sessions: sessions.size,
      buckets: limiter.size,
      queued,
      durablePending: durable.pending(),
    }),
    stop: () => durable.stop(),
  };
}
