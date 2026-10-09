/**
 * Resume and replay (B042, CT-RESUME "Flow", CT-WS-ENVELOPE "Handshake"): a reconnecting client
 * gets the sequenced frames it missed, in order, then `sys.resumed`, then live traffic, with no gap
 * and no duplicate between them.
 *
 * - **When:** a `sys.hello` with `last_seq` (through the handshake: `hold` before the room join,
 *   `prepare` before the welcome, `start` after it), or a `sys.resume {last_seq}` later (the stage,
 *   order 45). Both use the connection's own session (the ticket's), never a frame's `sid`. The
 *   handshake's live membership check comes first: a revoked member is closed 4403 and gets nothing.
 * - **Plan** (`last_seq` = L, the store's head = H):
 *   - L = null: a fresh join, nothing replayed, `welcome.resume` null, no `sys.resumed`.
 *   - L within the hot buffer (or L = H): L+1..H is replayed.
 *   - L older than the buffer, L > H, or H − L > RELAY_REPLAY_MAX_FRAMES: `sys.resumed
 *     {snapshot_required: true, snapshot_seq}` when a snapshot newer than L exists (any snapshot
 *     for L > H). Without one (CT-RESUME: `snapshot_required` is then never sent) the relay replays
 *     what it still has: from L+1 through the durable log, or the newest MAX_FRAMES for a window
 *     too long or a client ahead of the server, with `history_gap: true` when frames after L are
 *     gone.
 *   - A `sys.resume {last_seq: S}` after a snapshot is the same rule: S is the snapshot's own seq,
 *     so the frames after it are replayed from the durable log and the hot buffer.
 * - **Replay:** batches of RELAY_REPLAY_BATCH frames, each read from the hot buffer when it still
 *   holds the batch's first frame, else from the durable log. Frames are sent as the exact JSON
 *   first delivered. Before each frame, while the connection's outbound buffer would pass 2 MiB, the
 *   replay waits for it to drain (B046's `whenDrained` when the relay has it, else polling); a
 *   client that reads nothing for STALL_MS is closed 4429 (`slow_consumer`). Then `sys.resumed {from_seq, to_seq, count}` (and `history_gap`).
 * - **Handoff:** from before the replay is planned, fan-out holds the connection's live frames
 *   (`FanOut.hold`); after `sys.resumed` the held frames above the last replayed `seq` are sent in
 *   order, and the hold ends in the same turn as the last one is taken, so nothing is missed. Live
 *   frames of the replayed range that fan-out releases late are skipped (`end(sentUpTo)`).
 * - **Failures:** a store or durable log that fails during a replay is `sys.error
 *   service_unavailable` (`retry_after_s` 1) with the connection kept, and live traffic resumes;
 *   the client sends `sys.resume` again. A second `sys.resume` while one runs is `sys.error
 *   invalid_frame` and is ignored.
 *
 * Logs carry the session, modes and counts, never `p`, `ct`, `sig` or ids.
 *
 * Owns: the plan, the replay and the handoff. Must not: decode, re-encode or reorder a frame, read
 * another session, or push past the outbound buffer limit.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Logger, type Metrics } from '@centcom/core';
import type { BackpressureController } from '../backpressure/controller.js';
import { CloseCode } from '../close-codes.js';
import { closeConnection } from '../connection/close.js';
import type { ConnectionEntry } from '../connection-registry.js';
import { connectionSender, type FanOut, type LiveHold } from '../fanout/fanout.js';
import type { AdmittedHello, HandshakeResume } from '../handshake/handshake.js';
import { WELCOME_LIMITS } from '../handshake/handshake.js';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import type { SeqStore, StoredFrame } from '../seq/types.js';
import type { Hydrator } from './hydrate.js';
import type { DurableLogReader, ResumeResult, SnapshotLookup } from './types.js';

/** A connection whose outbound buffer has not drained for this long during a replay is closed 4429. */
export const STALL_MS = 30_000;
/** How often a replay waiting for the outbound buffer looks again. */
export const DRAIN_POLL_MS = 5;
/** With B046's controller, the longest a replay waits for its drain signal before looking again. */
export const DRAIN_WAIT_MS = 100;
/** `relay_resume_duration_seconds` buckets. */
export const RESUME_BUCKETS_S: readonly number[] = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
]);

/** The details of the module's refusals (GUIDELINES §3.4). */
export const RESUME_DETAILS = Object.freeze({
  busy: 'A resume is already in progress on this connection.',
  lastSeq: 'sys.resume needs p.last_seq, a whole number from 0.',
  unavailable: 'The replay could not be read right now; send sys.resume again shortly.',
  stalled: 'The connection did not read its replay.',
} as const);

/** What the resumer needs. */
export interface ResumerDeps {
  store: Pick<SeqStore, 'head' | 'oldest' | 'range'>;
  durable: DurableLogReader;
  snapshots: SnapshotLookup;
  hydrator: Pick<Hydrator, 'ensure'>;
  /** Fan-out (`ctx.fanout`), looked up when needed: its module registers after this one. */
  fanout: () => Pick<FanOut, 'hold' | 'release'> | undefined;
  /** RELAY_REPLAY_BATCH. */
  batch: number;
  /** RELAY_REPLAY_MAX_FRAMES. */
  maxFrames: number;
  /** Default `WELCOME_LIMITS.outbound_buffer_bytes` (2 MiB). */
  outboundLimit?: number;
  /** Default STALL_MS. */
  stallMs?: number;
  /** Default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds, for the stall limit; default Date.now. */
  now?: () => number;
  /**
   * B046's controller (`ctx.backpressure`), looked up when a replay waits: it resolves
   * `whenDrained` once the connection is under its soft mark. None: the replay polls.
   */
  outbound?: () => Pick<BackpressureController, 'whenDrained'> | undefined;
  /** Seconds for the duration metric; default performance.now / 1000. */
  monotonic?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** What a resume will do. */
type Plan =
  | { kind: 'none' }
  | { kind: 'snapshot'; snapshotSeq: number }
  | { kind: 'replay'; after: number; to: number; gap: boolean };

interface ConnState {
  hold: LiveHold | null;
  plan: Plan | null;
  /** When the resume began (monotonic seconds). */
  began: number;
}

/** The resumer: the handshake's hooks, `resumeConnection` and the `sys.resume` stage. */
export interface Resumer extends HandshakeResume {
  /** Resumes `conn` (authenticated) from `lastSeq`: holds, plans, replays, hands off. */
  resumeConnection(conn: RelayConnection, lastSeq: number | null): Promise<ResumeResult>;
  /** The `sys.resume` stage (order 45). */
  stage: InboundStage;
  /** True while `conn` is resuming. */
  busy(conn: RelayConnection): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `sys.error` with `error`, about the frame `ref` when there is one. */
function sysError(error: AppError, ref?: unknown): object {
  return {
    v: 1,
    t: 'sys.error',
    ...(typeof ref === 'string' ? { ref } : {}),
    p: toProblem(error, { requestId: newId('req') }),
  };
}

/** `welcome.resume` for a plan. */
function welcomeResume(plan: Plan): object | null {
  if (plan.kind === 'none') return null;
  if (plan.kind === 'snapshot') return { snapshot_required: true, snapshot_seq: plan.snapshotSeq };
  return { from_seq: plan.after + 1, to_seq: plan.to };
}

/** The resumer. */
export function createResumer(deps: ResumerDeps): Resumer {
  const metrics = deps.metrics ?? noopMetrics;
  const limit = deps.outboundLimit ?? WELCOME_LIMITS.outbound_buffer_bytes;
  const stallMs = deps.stallMs ?? STALL_MS;
  const sleep = deps.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
  const monotonic = deps.monotonic ?? (() => performance.now() / 1000);
  const now = deps.now ?? Date.now;
  const duration = metrics.histogram('relay_resume_duration_seconds', RESUME_BUCKETS_S);
  const states = new WeakMap<ConnectionEntry, ConnState>();

  const isOpen = (conn: RelayConnection): boolean => conn.entry.state !== 'closing';

  /**
   * The store's head, and fan-out's order for the session starts after it when it has none yet
   * (B045: with frames from other nodes, the first to arrive need not be the lowest).
   */
  async function headOf(sid: string): Promise<number> {
    const head = await deps.store.head(sid);
    deps.fanout()?.release.prime(sid, head + 1);
    return head;
  }

  /** The plan for `lastSeq` in session `sid` at `head` (see the module comment). */
  async function planFor(sid: string, lastSeq: number | null, head: number): Promise<Plan> {
    if (lastSeq === null) return { kind: 'none' };
    const last = Math.max(0, lastSeq);
    const newest = (): Plan => ({
      kind: 'replay',
      after: Math.max(0, head - deps.maxFrames),
      to: head,
      gap: true,
    });
    if (last > head) {
      const snap = await deps.snapshots.latestSeq(sid);
      return snap === null ? newest() : { kind: 'snapshot', snapshotSeq: snap };
    }
    if (head - last > deps.maxFrames) {
      const snap = await deps.snapshots.latestSeq(sid);
      return snap !== null && snap > last ? { kind: 'snapshot', snapshotSeq: snap } : newest();
    }
    if (last < head) {
      const oldest = await deps.store.oldest(sid);
      if (oldest === null || last + 1 < oldest) {
        const snap = await deps.snapshots.latestSeq(sid);
        if (snap !== null && snap > last) return { kind: 'snapshot', snapshotSeq: snap };
      }
    }
    return { kind: 'replay', after: last, to: head, gap: false };
  }

  /** Sends `text`, waiting while the outbound buffer would pass the limit; false when it cannot. */
  async function send(conn: RelayConnection, text: string): Promise<boolean> {
    const sender = connectionSender(conn);
    const bytes = Buffer.byteLength(text, 'utf8');
    const started = now();
    while (sender.bufferedBytes() > 0 && sender.bufferedBytes() + bytes > limit) {
      if (!isOpen(conn)) return false;
      if (now() - started >= stallMs) {
        metrics.counter('relay_resume_stalled_total').inc();
        closeConnection(conn, {
          code: CloseCode.RateLimited,
          errorCode: 'slow_consumer',
          detail: RESUME_DETAILS.stalled,
        });
        return false;
      }
      // B046's controller wakes the replay when the connection drains; else, poll.
      const outbound = deps.outbound?.();
      await (outbound === undefined
        ? sleep(DRAIN_POLL_MS)
        : Promise.race([outbound.whenDrained(conn), sleep(DRAIN_WAIT_MS)]));
    }
    return sender.send(text, { droppable: false }) === 'queued';
  }

  /** Replays `plan`'s window to `conn`; what was sent. Throws when the store or the log fails. */
  async function replay(
    conn: RelayConnection,
    sid: string,
    plan: Extract<Plan, { kind: 'replay' }>,
  ): Promise<{ first: number | null; last: number; count: number; gap: boolean }> {
    let cursor = plan.after;
    let first: number | null = null;
    let count = 0;
    let gap = plan.gap;
    let empty = 0;
    while (cursor < plan.to && isOpen(conn)) {
      const n = Math.min(deps.batch, plan.to - cursor);
      const oldest = await deps.store.oldest(sid);
      const hot = oldest !== null && cursor + 1 >= oldest;
      const read = hot
        ? await deps.store.range(sid, cursor, n)
        : await deps.durable.range(sid, cursor, n);
      const frames = read.filter((f) => f.seq > cursor && f.seq <= plan.to);
      metrics
        .counter('relay_replay_frames_total', { source: hot ? 'hot' : 'durable' })
        .inc(frames.length);
      if (frames.length === 0) {
        empty += 1;
        if (!hot && oldest !== null && oldest > cursor + 1) {
          // The durable log cannot fill the frames before the buffer: they are gone.
          gap = true;
          cursor = oldest - 1;
          continue;
        }
        // Nothing left to read (or the buffer moved under the read twice): what remains is gone.
        if (!hot || empty > 1) {
          gap = true;
          break;
        }
        continue;
      }
      empty = 0;
      if ((frames[0] as StoredFrame).seq !== cursor + 1) gap = true;
      for (const frame of frames) {
        if (!(await send(conn, JSON.stringify(frame)))) return { first, last: cursor, count, gap };
        first ??= frame.seq;
        cursor = frame.seq;
        count += 1;
      }
    }
    return { first, last: cursor, count, gap };
  }

  /** Sends the held frames (those above `sentUpTo` when given) and ends the hold. */
  async function handOff(conn: RelayConnection, hold: LiveHold | null, sentUpTo: number | null) {
    if (hold === null) return;
    let last = sentUpTo;
    for (;;) {
      if (!isOpen(conn) || hold.overflowed) {
        hold.end();
        return;
      }
      const held = hold.next();
      if (held === undefined) {
        // Same turn as the last `next`: nothing can be held in between.
        hold.end(last ?? undefined);
        return;
      }
      if (last !== null && held.seq <= last) continue;
      if (!(await send(conn, held.text))) {
        hold.end();
        return;
      }
      if (last !== null) last = held.seq;
    }
  }

  /** Reports a resume that failed: counted, logged and told to the client (503, kept open). */
  function failed(conn: RelayConnection, sid: string, state: ConnState, err: unknown): void {
    metrics.counter('relay_resume_total', { result: 'failed' }).inc();
    duration.observe(monotonic() - state.began, { result: 'failed' });
    deps.logger?.warn(
      { sid, error: err instanceof Error ? err.name : typeof err },
      'relay.resume_failed',
    );
    if (!isOpen(conn)) return;
    conn.send(
      sysError(
        new AppError('service_unavailable', {
          detail: RESUME_DETAILS.unavailable,
          retryAfterS: 1,
        }),
      ),
    );
  }

  /** Carries out `state.plan` for `conn`, then hands off. */
  async function run(conn: RelayConnection, sid: string, state: ConnState): Promise<ResumeResult> {
    const plan = state.plan ?? { kind: 'none' };
    let result: ResumeResult = { mode: 'none' };
    let sentUpTo: number | null = null;
    try {
      if (plan.kind === 'snapshot') {
        conn.send({
          v: 1,
          t: 'sys.resumed',
          p: { snapshot_required: true, snapshot_seq: plan.snapshotSeq },
        });
        result = { mode: 'snapshot_required', snapshotSeq: plan.snapshotSeq };
      } else if (plan.kind === 'replay') {
        const sent = await replay(conn, sid, plan);
        sentUpTo = sent.last;
        result = {
          mode: 'replayed',
          fromSeq: sent.first ?? sent.last + 1,
          toSeq: sent.last,
          count: sent.count,
          ...(sent.gap ? { historyGap: true } : {}),
        };
        if (isOpen(conn)) {
          conn.send({
            v: 1,
            t: 'sys.resumed',
            p: {
              from_seq: result.fromSeq,
              to_seq: result.toSeq,
              count: result.count,
              ...(sent.gap ? { history_gap: true } : {}),
            },
          });
        }
      }
      if (plan.kind !== 'none') {
        metrics.counter('relay_resume_total', { result: result.mode }).inc();
        duration.observe(monotonic() - state.began, { result: 'ok' });
        deps.logger?.info(
          { sid, mode: result.mode, count: result.count ?? 0, gap: result.historyGap === true },
          'relay.resumed',
        );
      }
    } catch (err) {
      failed(conn, sid, state, err);
      result = { mode: 'none' };
      sentUpTo = null;
    }
    try {
      await handOff(conn, state.hold, sentUpTo);
    } finally {
      if (states.get(conn.entry) === state) states.delete(conn.entry);
    }
    return result;
  }

  function hold(conn: RelayConnection): void {
    states.get(conn.entry)?.hold?.end();
    states.set(conn.entry, {
      hold: deps.fanout()?.hold(conn) ?? null,
      plan: null,
      began: monotonic(),
    });
  }

  async function prepare(conn: RelayConnection, admitted: AdmittedHello): Promise<object | null> {
    const state = states.get(conn.entry);
    await deps.hydrator.ensure(admitted.sid);
    const plan = await planFor(admitted.sid, admitted.lastSeq, await headOf(admitted.sid));
    if (state !== undefined) state.plan = plan;
    return welcomeResume(plan);
  }

  function start(conn: RelayConnection): void {
    const state = states.get(conn.entry);
    const sid = conn.entry.sessionId;
    if (state === undefined || sid === null) return;
    void run(conn, sid, state);
  }

  function abandon(conn: RelayConnection): void {
    const state = states.get(conn.entry);
    if (state === undefined) return;
    state.hold?.end();
    states.delete(conn.entry);
  }

  async function resumeConnection(
    conn: RelayConnection,
    lastSeq: number | null,
  ): Promise<ResumeResult> {
    const sid = conn.entry.sessionId;
    if (sid === null) return { mode: 'none' };
    hold(conn);
    const state = states.get(conn.entry) as ConnState;
    try {
      await deps.hydrator.ensure(sid);
      state.plan = await planFor(sid, lastSeq, await headOf(sid));
    } catch (err) {
      // Planning failed (recovery or the store): reported, and live traffic goes on.
      failed(conn, sid, state, err);
      try {
        await handOff(conn, state.hold, null);
      } finally {
        if (states.get(conn.entry) === state) states.delete(conn.entry);
      }
      return { mode: 'none' };
    }
    return run(conn, sid, state);
  }

  const stage: InboundStage = async (fc, next) => {
    const frame = fc.frame;
    if (!isRecord(frame) || frame['t'] !== 'sys.resume') {
      await next();
      return;
    }
    const conn = fc.connection;
    if (conn.entry.sessionId === null) return;
    const p = frame['p'];
    const lastSeq = isRecord(p) ? p['last_seq'] : undefined;
    if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      conn.send(
        sysError(
          new AppError('invalid_frame', {
            detail: RESUME_DETAILS.lastSeq,
            errors: [{ pointer: '/p/last_seq', code: 'invalid', detail: 'must be a seq' }],
          }),
          frame['id'],
        ),
      );
      return;
    }
    if (states.has(conn.entry)) {
      metrics.counter('relay_resume_total', { result: 'busy' }).inc();
      conn.send(
        sysError(new AppError('invalid_frame', { detail: RESUME_DETAILS.busy }), frame['id']),
      );
      return;
    }
    void resumeConnection(conn, lastSeq);
  };

  return {
    hold,
    prepare,
    start,
    abandon,
    resumeConnection,
    stage,
    busy: (conn) => states.has(conn.entry),
  };
}
