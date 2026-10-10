/**
 * The queue service (B052, CT-WS-QUEUE): validates and applies `queue.*` frames, keeps each
 * session's queue durable and serialised across nodes, auto-approves by policy, and emits the
 * authoritative `queue.state` after every change.
 *
 * For a queue frame (roles already checked by B043 from live membership: submit and cancel for
 * host and editor, the rest host only; a muted member's frames never get here):
 *
 * 1. **Before the lock:** a resend this node accepted passes straight to sequencing (B041 echoes
 *    its original `seq`). A submit's `p.size` over 192 KiB is `invalid_frame` (`/p/size`).
 * 2. **Under the session's lock** (`QueueStore.withSession`, held until the frame is sequenced,
 *    so the versions follow `seq` order on every node):
 *    - The queue is loaded: this node's copy when it is current, else the stored rows plus a
 *      replay of the frames sequenced after them.
 *    - The policy (B051) and the pause are checked:
 *      - submit to a locked session: `forbidden`, audited;
 *      - more than 5 live items of the member, or `queue_limit` live items in the session:
 *        `queue_full`;
 *      - approve or claim while approvals are paused (the policy's `queue_paused`, or the quota
 *        hook): `queue_not_allowed`.
 *    - The state machine decides. Its refusals are `sys.error` to the sender only, and nothing is
 *      sequenced (an unknown or finished item: `queue_item_gone`). A resubmitted item (same
 *      `que_` id) is echoed with its original `seq` and changes nothing.
 *    - The new queue is saved before sequencing. A failed save is `service_unavailable`, and the
 *      queue is unchanged.
 *    - The frame is sequenced. An auto-approval (`policy-approver.ts`) goes in the same batch
 *      (`COMPANION_FRAMES_KEY`): `queue.submit` and the relay's `queue.approve` get consecutive
 *      `seq`s, or neither is sequenced.
 *    - The change is applied with the frame's real `seq` and `ts`, saved with that `seq`, and
 *      `queue.state` is emitted.
 *    - If the frame was not sequenced, the transaction is rolled back.
 * 3. A reorder listing unknown ids is applied for the known ones; the sender gets
 *    `queue_item_gone` once.
 *
 * **Host loss** (`onHostDisconnected` / `onHostReconnected` / `onHostChanged`): approved and
 * running items become `held`, then return. A frame from the host also ends a host absence.
 * `setApprovalsPaused` is the quota service's switch (B076).
 *
 * Owns: the queue rules and their order. Must not: read or store `ct`, order by client
 * timestamps, or log anything but ids, kinds, counts and codes.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  toProblem,
  unavailable,
  type AuditEmitter,
  type ErrorCode,
  type Logger,
  type Metrics,
  type Problem,
} from '@centcom/core';
import type { RelayConnection } from '../pipeline.js';
import type { SessionRole } from '../rooms/kind-policy.js';
import { SERVER_FROM, type StoredFrame, type UnsequencedFrame } from '../seq/types.js';
import { autoApproval, autoApproveId } from './policy-approver.js';
import type { PolicyReader, QueuePolicy, QueueSequencer, QueueStore, QueueTx } from './ports.js';
import {
  emptyQueue,
  LIVE_STATES,
  opOf,
  reduce,
  replay,
  view,
  type QueueModel,
  type QueueOp,
  type QueueStateBody,
} from './state-machine.js';

/** CT-WS-QUEUE rule 8: largest `queue.submit.p.size`, in bytes (192 KiB). */
export const MAX_ITEM_BYTES = 196_608;
/** CT-WS-QUEUE rule 2: live items per member. */
export const MAX_LIVE_PER_MEMBER = 5;
/** Accepted frames remembered per node, for resends. */
export const RECENT_QUEUE_FRAMES_MAX = 10_000;
/** Sessions whose queue is kept in memory per node (oldest out first). */
export const QUEUE_CACHE_MAX_SESSIONS = 10_000;

/** The details of the service's own refusals (GUIDELINES §3.4). */
export const QUEUE_SERVICE_DETAILS = Object.freeze({
  size: 'A queue item can be at most 192 KiB.',
  locked: 'The host has locked this session’s queue.',
  memberFull: 'You already have 5 items in the queue.',
  sessionFull: 'The session’s queue is full.',
  paused: 'Approvals are paused for this session.',
  unavailable: 'The queue is unavailable right now; try again shortly.',
  unknownItems: 'Some of those items no longer exist or have finished; the rest were reordered.',
} as const);

/** A queue frame as it reaches the service (decoded by B039, roles checked by B043). */
export interface QueueFrameIn {
  t: 'queue';
  /** The frame's `msg_` id. */
  id: string;
  k: string;
  p?: unknown;
}

/** What happened to a frame. */
export type QueueOutcome =
  /** `notice`: told to the sender although the frame was applied (a reorder naming unknown items). */
  | { accepted: true; seqs: number[]; notice?: Problem }
  /** `error` is what the sender is told; absent when B041 already answered or echoed. */
  | { accepted: false; error?: Problem };

/** The sender, as the room knows them. */
export interface QueueSender {
  /** `mem_`. */
  id: string;
  role: SessionRole;
  userId: string;
  workspaceId: string | null;
}

/** What sequencing gave back: the frame and the companions sequenced with it. */
export interface Sequenced {
  frame: StoredFrame;
  companions: StoredFrame[];
}

/** One frame's context. */
export interface QueueContext {
  sid: string;
  sender: QueueSender;
  connection: RelayConnection;
  /** Runs sequencing (with `companions` in the same batch) and fan-out; undefined when not sequenced. */
  sequence(companions: UnsequencedFrame[]): Promise<Sequenced | undefined>;
}

/** What the service needs. */
export interface QueueServiceDeps {
  store: QueueStore;
  policies: PolicyReader;
  sequencer: QueueSequencer;
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The queue service. */
export interface QueueService {
  handle(ctx: QueueContext, frame: QueueFrameIn): Promise<QueueOutcome>;
  /** This node's latest view of `sid`'s queue (empty when it has none). */
  snapshot(sid: string): QueueStateBody;
  /** The host's last connection here closed: approved and running items are held. */
  onHostDisconnected(sid: string): Promise<void>;
  /** The host is back (or connected): held items return. */
  onHostReconnected(sid: string): Promise<void>;
  /** B051: the host changed and the new host is connected; held items show as approved again. */
  onHostChanged(sid: string): Promise<void>;
  /** The quota service (B076): approvals and auto-approvals wait while paused. */
  setApprovalsPaused(sid: string, paused: boolean): void;
  /** The latest `queue.state` frame this node emitted for `sid`, for a joiner. */
  lastState(sid: string): StoredFrame | undefined;
}

/** Thrown inside the lock to roll the transaction back with an outcome. */
class Abort extends Error {
  constructor(readonly outcome: QueueOutcome) {
    super('queue frame not applied');
  }
}

interface Cached {
  model: QueueModel;
  updatedSeq: number;
  lastState?: StoredFrame;
}

/** The service over `deps`. */
export function createQueueService(deps: QueueServiceDeps): QueueService {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const cache = new Map<string, Cached>();
  const recent = new Set<string>();
  const paused = new Set<string>();

  const problem = (code: ErrorCode, detail: string, pointer?: string): Problem =>
    toProblem(
      new AppError(code, {
        detail,
        ...(pointer === undefined
          ? {}
          : { errors: [{ pointer, code: 'invalid', detail: 'is not allowed' }] }),
      }),
      { requestId: newId('req') },
    );
  const unavailableProblem = (): Problem =>
    toProblem(unavailable(1, QUEUE_SERVICE_DETAILS.unavailable), { requestId: newId('req') });

  function remember<T>(set: Set<T> | Map<T, unknown>, max: number): void {
    while (set.size > max) {
      const oldest = set.keys().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  function reject(code: ErrorCode, kind: string): void {
    metrics.counter('relay_queue_rejections_total', { code }).inc();
    deps.logger?.info({ kind, code }, 'relay.queue_rejected');
  }

  function countStates(model: QueueModel, changed: readonly string[]): void {
    for (const id of changed) {
      const state = model.items.get(id)?.state;
      if (state !== undefined) metrics.counter('relay_queue_items_total', { state }).inc();
    }
  }

  /** The session's queue under the lock: this node's copy if current, else rows plus catch-up. */
  async function load(
    sid: string,
    tx: QueueTx,
  ): Promise<{ model: QueueModel; updatedSeq: number }> {
    const stored = await tx.load();
    const mine = cache.get(sid);
    if (
      mine !== undefined &&
      ((stored === null && mine.model.version === 0) ||
        (stored !== null &&
          stored.version === mine.model.version &&
          stored.updatedSeq === mine.updatedSeq))
    ) {
      return { model: mine.model, updatedSeq: mine.updatedSeq };
    }
    let model = emptyQueue();
    let updatedSeq = 0;
    if (stored !== null) {
      model = {
        version: stored.version,
        hostAway: stored.hostAway,
        order: stored.order,
        items: new Map(stored.items.map((i) => [i.item, i])),
      };
      updatedSeq = stored.updatedSeq;
    }
    // Frames sequenced after the rows (a crash between sequencing and commit).
    const after = await deps.sequencer.framesAfter(sid, updatedSeq);
    if (after.length > 0) {
      model = replay(model, after);
      updatedSeq = after.at(-1)?.seq ?? updatedSeq;
    }
    return { model, updatedSeq };
  }

  function keep(sid: string, entry: Cached): void {
    cache.delete(sid);
    cache.set(sid, entry);
    remember(cache, QUEUE_CACHE_MAX_SESSIONS);
  }

  /** Emits `queue.state` for `model`; the stored frame, or undefined when it could not go out. */
  async function emitState(sid: string, model: QueueModel): Promise<StoredFrame | undefined> {
    try {
      return await deps.sequencer.emitState(sid, view(model));
    } catch (err) {
      deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : typeof err },
        'relay.queue_state_failed',
      );
      return undefined;
    }
  }

  /** Applies a host absence change under the lock; true when the queue changed. */
  async function hostChange(
    sid: string,
    tx: QueueTx,
    current: { model: QueueModel; updatedSeq: number },
    away: boolean,
  ): Promise<{ model: QueueModel; updatedSeq: number; state?: StoredFrame } | undefined> {
    if (current.model.hostAway === away) return undefined;
    const r = reduce(current.model, { k: 'host', away }, current.updatedSeq, '');
    if (!r.ok) return undefined;
    await tx.save(r.model, r.changed, current.updatedSeq);
    countStates(r.model, r.changed);
    const state = await emitState(sid, r.model);
    return { model: r.model, updatedSeq: current.updatedSeq, ...(state ? { state } : {}) };
  }

  async function onHost(sid: string, away: boolean): Promise<void> {
    const mine = cache.get(sid);
    if (mine !== undefined && mine.model.hostAway === away) return;
    try {
      const done: { model: QueueModel; updatedSeq: number; state?: StoredFrame } =
        await deps.store.withSession(sid, async (tx) => {
          const current = await load(sid, tx);
          return (await hostChange(sid, tx, current, away)) ?? current;
        });
      const lastState = done.state ?? cache.get(sid)?.lastState;
      keep(sid, {
        model: done.model,
        updatedSeq: done.updatedSeq,
        ...(lastState === undefined ? {} : { lastState }),
      });
      deps.logger?.info({ sid, status: away ? 'away' : 'back' }, 'relay.queue_host');
    } catch (err) {
      deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : typeof err },
        'relay.queue_host_failed',
      );
    }
  }

  function auditDenied(ctx: QueueContext, kind: string, reason: string): void {
    deps.audit?.emitDetached({
      workspaceId: ctx.sender.workspaceId,
      actor: { type: 'user', id: ctx.sender.userId },
      action: 'permission.denied',
      target: { type: 'session', id: ctx.sid },
      outcome: 'denied',
      meta: { attempted: kind, reason, session_id: ctx.sid },
    });
  }

  /** The policy checks of `op` before the state machine. */
  function checkPolicy(
    ctx: QueueContext,
    op: QueueOp,
    model: QueueModel,
    policy: QueuePolicy,
  ): QueueOutcome | undefined {
    const fail = (code: ErrorCode, detail: string): QueueOutcome => {
      reject(code, op.k);
      return { accepted: false, error: problem(code, detail) };
    };
    if (op.k === 'queue.submit') {
      if (policy.locked) {
        auditDenied(ctx, op.k, 'locked');
        return fail('forbidden', QUEUE_SERVICE_DETAILS.locked);
      }
      if (model.items.has(op.item)) return undefined;
      const live = [...model.items.values()].filter((i) => LIVE_STATES.has(i.state));
      if (live.filter((i) => i.submitter === op.from).length >= MAX_LIVE_PER_MEMBER) {
        return fail('queue_full', QUEUE_SERVICE_DETAILS.memberFull);
      }
      if (live.length >= policy.queue_limit) {
        return fail('queue_full', QUEUE_SERVICE_DETAILS.sessionFull);
      }
    }
    if (
      (op.k === 'queue.approve' || op.k === 'queue.claim') &&
      (policy.queue_paused || paused.has(ctx.sid))
    ) {
      return fail('queue_not_allowed', QUEUE_SERVICE_DETAILS.paused);
    }
    return undefined;
  }

  async function run(ctx: QueueContext, frame: QueueFrameIn): Promise<QueueOutcome> {
    const { sid, sender } = ctx;
    const op = opOf(frame.k, sender.id, frame.p);
    if (op === null)
      return { accepted: false, error: problem('invalid_frame', 'Not a queue frame.', '/k') };
    if (op.k === 'queue.submit' && op.size > MAX_ITEM_BYTES) {
      reject('invalid_frame', op.k);
      return {
        accepted: false,
        error: problem('invalid_frame', QUEUE_SERVICE_DETAILS.size, '/p/size'),
      };
    }
    let policy: QueuePolicy;
    try {
      policy = await deps.policies.get(sid);
    } catch {
      return { accepted: false, error: unavailableProblem() };
    }
    let result: {
      outcome: QueueOutcome;
      model: QueueModel;
      updatedSeq: number;
      state?: StoredFrame;
    };
    try {
      result = await deps.store.withSession(sid, async (tx) => {
        let current = await load(sid, tx);
        let lastState: StoredFrame | undefined;
        // A frame from the host ends a host absence first.
        if (sender.role === 'host' && current.model.hostAway) {
          const back = await hostChange(sid, tx, current, false);
          if (back !== undefined) {
            current = back;
            lastState = back.state;
          }
        }
        const refused = checkPolicy(ctx, op, current.model, policy);
        if (refused !== undefined) throw new Abort(refused);

        // Decide with a provisional seq; the real one is applied once sequenced.
        const provisional = reduce(
          current.model,
          op,
          current.updatedSeq + 1,
          new Date(clock()).toISOString(),
        );
        if (!provisional.ok) {
          if (provisional.refusal === 'duplicate' && op.k === 'queue.submit') {
            const existing = current.model.items.get(op.item);
            if (existing?.submitter === sender.id) {
              await deps.sequencer.resend(ctx.connection, sid, existing.createdSeq);
              throw new Abort({ accepted: true, seqs: [existing.createdSeq] });
            }
            reject('conflict', op.k);
            throw new Abort({
              accepted: false,
              error: problem('conflict', provisional.detail, '/p/item'),
            });
          }
          const code: ErrorCode =
            provisional.refusal === 'duplicate' ? 'conflict' : provisional.refusal;
          if (code === 'forbidden') auditDenied(ctx, op.k, 'state');
          reject(code, op.k);
          throw new Abort({ accepted: false, error: problem(code, provisional.detail) });
        }
        const auto =
          op.k === 'queue.submit'
            ? autoApproval(policy, { id: sender.id, role: sender.role }, paused.has(sid))
            : null;
        await tx.save(provisional.model, provisional.changed, current.updatedSeq);

        const companions: UnsequencedFrame[] =
          auto !== null && op.k === 'queue.submit'
            ? [
                {
                  v: 1,
                  t: 'queue',
                  id: autoApproveId(op.item),
                  sid,
                  from: SERVER_FROM,
                  ts: new Date(clock()).toISOString(),
                  k: 'queue.approve',
                  p: { item: op.item, reason: 'policy', policy: auto },
                } as UnsequencedFrame,
              ]
            : [];
        const sequenced = await ctx.sequence(companions);
        if (sequenced === undefined) throw new Abort({ accepted: false });

        // Apply with the real seq and ts (what every replay will see).
        let applied = reduce(current.model, op, sequenced.frame.seq, sequenced.frame.ts);
        if (!applied.ok) throw new Error('queue: the state machine changed its mind');
        let model = applied.model;
        const changed = [...applied.changed];
        countStates(model, applied.changed);
        let updatedSeq = sequenced.frame.seq;
        for (const companion of sequenced.companions) {
          const companionOp = opOf(companion.k, companion.from, (companion as { p?: unknown }).p);
          if (companionOp === null) continue;
          applied = reduce(model, companionOp, companion.seq, companion.ts);
          if (applied.ok) {
            model = applied.model;
            changed.push(...applied.changed);
            countStates(model, applied.changed);
          }
          updatedSeq = companion.seq;
        }
        await tx.save(model, changed, updatedSeq);
        const state = (await emitState(sid, model)) ?? lastState;
        const seqs = [sequenced.frame.seq, ...sequenced.companions.map((c) => c.seq)];
        const outcome: QueueOutcome = provisional.gone
          ? {
              accepted: true,
              seqs,
              notice: problem('queue_item_gone', QUEUE_SERVICE_DETAILS.unknownItems, '/p/order'),
            }
          : { accepted: true, seqs };
        if (provisional.gone) reject('queue_item_gone', op.k);
        return { outcome, model, updatedSeq, ...(state ? { state } : {}) };
      });
    } catch (err) {
      if (err instanceof Abort) return err.outcome;
      deps.logger?.warn(
        { sid, kind: frame.k, error: err instanceof Error ? err.name : typeof err },
        'relay.queue_unavailable',
      );
      reject('service_unavailable', frame.k);
      return { accepted: false, error: unavailableProblem() };
    }
    const previous = cache.get(sid);
    keep(sid, {
      model: result.model,
      updatedSeq: result.updatedSeq,
      ...(result.state
        ? { lastState: result.state }
        : previous?.lastState
          ? { lastState: previous.lastState }
          : {}),
    });
    deps.logger?.info({ sid, kind: frame.k, version: result.model.version }, 'relay.queue_changed');
    return result.outcome;
  }

  return {
    async handle(ctx, frame) {
      const key = `${ctx.sid}:${ctx.sender.id}:${frame.id}`;
      if (recent.has(key)) {
        // A resend: B041 echoes the original seq; nothing changes.
        const echoed = await ctx.sequence([]).catch(() => undefined);
        return { accepted: true, seqs: echoed === undefined ? [] : [echoed.frame.seq] };
      }
      const outcome = await run(ctx, frame);
      if (outcome.accepted) {
        recent.add(key);
        remember(recent, RECENT_QUEUE_FRAMES_MAX);
      }
      return outcome;
    },
    snapshot: (sid) => view(cache.get(sid)?.model ?? emptyQueue()),
    onHostDisconnected: (sid) => onHost(sid, true),
    onHostReconnected: (sid) => onHost(sid, false),
    onHostChanged: (sid) => onHost(sid, false),
    setApprovalsPaused(sid, value) {
      if (value) paused.add(sid);
      else paused.delete(sid);
    },
    lastState: (sid) => cache.get(sid)?.lastState,
  };
}
