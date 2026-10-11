/**
 * The advisory file-lock service (B059, CT-WS-SESSION-EVENTS `file.lock`): acquire, release and
 * expiry of locks on `path_hmac`, with TTLs and first-come fairness, never seeing a path.
 *
 * - **Acquire** (`action: acquire`, clients): a free path is granted and the client's frame is
 *   sequenced (everyone sees the holder). The holder's own re-acquire extends the TTL and is
 *   sequenced. A path held by another agent: the requester joins the path's wait queue (FIFO, at
 *   most 10) and a server `file.lock {action: deny, agent_id: <holder>}` is sequenced; the 11th is
 *   denied without queueing. The 501st lock of a session and the 101st of an agent are denied
 *   (`agent_id` then the requester's own). A denied acquire is not sequenced; B061 is told who
 *   holds the path (`ConflictHintPort`).
 * - **Release** (`action: release`): by the holder's member (or the host) frees the path and
 *   grants the first waiter in the same sequencing batch (a server `acquire` for it). A release by
 *   anyone else is ignored (not sequenced).
 * - **Expiry:** a lock lives its TTL, ttl_ms (CT-WS-SESSION-EVENTS "Limits": default 300 000, clamped to
 *   5 000 to 3 600 000). `sweep(now)` frees expired locks with a server `expire` each and grants
 *   their first waiters; an acquire that finds an expired lock does the same first.
 * - **Cleanup:** `releaseAllForAgent` (the agent's `agent.exit`), `releaseAllForMember` (the member
 *   was kicked: `control.kick`, which B051 follows with `control.member_left`), `releaseAll` (the
 *   session ended: `control.end`) and `releaseIfGone` (the member left: connected on no relay node
 *   10 s after its last connection closed, CT-WS-SESSION-EVENTS' reconnect grace) free their locks
 *   with `expire` frames, grant waiters, and drop their own waiters. Which nodes a member is
 *   connected on is kept with the session's locks (`memberJoined`, `memberLeft`), so a member still
 *   connected elsewhere keeps its locks.
 * - **Order:** a change is saved before anything about it is sequenced; a failed save is a 503 and
 *   nothing goes out. When sequencing refuses a client's frame, the state before it is saved back,
 *   and its outcome is not remembered (a resend is handled afresh).
 * - `deny` and `expire` are the server's: a client sending them gets `invalid_frame`. A resend of a
 *   frame (same sid, sender and id) replays its outcome and queues nothing twice.
 * - Redis down: `service_unavailable`, never an unsynchronised grant.
 *
 * Owns: arbitration. Must not: read, derive or log a path (it stays in `ct`), or hold a frame
 * waiting for a lock (a denial is immediate).
 */
import { isId, newId, validateEvent } from '@centcom/contracts';
import { AppError, noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { SERVER_FROM, type UnsequencedFrame } from '../seq/types.js';
import {
  clampTtl,
  MAX_LOCKS_PER_AGENT,
  MAX_LOCKS_PER_SESSION,
  PATH_HMAC,
  type ConflictHintPort,
  type DenyReason,
  type FileLockFrameIn,
  type HeldLock,
  type LockContext,
  type LockEmitter,
  type LockOutcome,
  type LockStore,
  type SessionLocks,
  type Waiter,
} from './ports.js';
import { dropWaiters, enqueue, next } from './waiters.js';

/** The details of refusals (GUIDELINES §3.4). */
export const LOCK_DETAILS = Object.freeze({
  malformed: 'The frame does not carry a valid file lock.',
  serverOnly: 'Only the relay sends file.lock deny and expire.',
  unavailable: 'File locks cannot be changed right now; try again shortly.',
} as const);

/** Buckets of `relay_lock_wait_ms`. */
const WAIT_BUCKETS_MS = [10, 100, 1_000, 10_000, 60_000, 300_000, 3_600_000];

/** Frames remembered for resend detection. */
export const RECENT_LOCK_FRAMES_MAX = 10_000;

/** What the service needs. */
export interface LockServiceDeps {
  store: LockStore;
  /** Sequences server frames outside a client frame (B044's emitServerBatch). */
  emitter: LockEmitter;
  hints?: ConflictHintPort;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** A parsed client frame. */
type LockRequest = {
  frameId: string;
  action: 'acquire' | 'release';
  path: string;
  agent: string;
  ttlMs: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The request in `p`; a refusal when it is not one. */
function parse(frameId: string, p: unknown): LockRequest | LockOutcome {
  if (!validateEvent('file.lock', p, { mode: 'tolerant' }).ok || !isRecord(p)) {
    return { outcome: 'refused', code: 'invalid_frame', detail: LOCK_DETAILS.malformed };
  }
  const action = p['action'];
  if (action === 'deny' || action === 'expire') {
    return { outcome: 'refused', code: 'invalid_frame', detail: LOCK_DETAILS.serverOnly };
  }
  const path = p['path_hmac'];
  const agent = p['agent_id'];
  if (
    (action !== 'acquire' && action !== 'release') ||
    typeof path !== 'string' ||
    !PATH_HMAC.test(path) ||
    !isId('agt', agent)
  ) {
    return { outcome: 'refused', code: 'invalid_frame', detail: LOCK_DETAILS.malformed };
  }
  const { ttl_ms: ttl } = p as { ttl_ms?: unknown };
  return { frameId, action, path, agent: agent as string, ttlMs: clampTtl(ttl) };
}

/** The file-lock service. */
export class LockService {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  /** Outcomes of recent frames, by `sid:from:id`. */
  readonly #recent = new Map<string, LockOutcome>();
  /** Sessions this node has seen locks in (swept). */
  readonly #sessions = new Set<string>();
  /** Locks held per session, as last saved here (the `relay_locks_held` gauge). */
  readonly #held = new Map<string, number>();

  constructor(private readonly deps: LockServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Locks held across the sessions this node has seen. */
  heldCount(): number {
    let n = 0;
    for (const v of this.#held.values()) n += v;
    return n;
  }

  /** A server `file.lock` frame of `sid`. */
  #frame(sid: string, p: Record<string, unknown>): UnsequencedFrame {
    return {
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid,
      from: SERVER_FROM,
      ts: new Date(this.#clock()).toISOString(),
      k: 'file.lock',
      p,
    } as UnsequencedFrame;
  }

  #deny(reason: DenyReason): void {
    this.#metrics.counter('relay_lock_denials_total', { reason }).inc();
  }

  #remember(key: string, outcome: LockOutcome): void {
    this.#recent.set(key, outcome);
    if (this.#recent.size > RECENT_LOCK_FRAMES_MAX) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
  }

  /**
   * Frees `path` (its holder gone), granting its first waiter: the server frames to sequence (an
   * `expire` for the old holder when `expire`, an `acquire` for the new one).
   */
  #free(
    sid: string,
    state: SessionLocks,
    path: string,
    expire: HeldLock | null,
    now: number,
  ): UnsequencedFrame[] {
    const frames: UnsequencedFrame[] = [];
    if (expire !== null) {
      frames.push(this.#frame(sid, { action: 'expire', path_hmac: path, agent_id: expire.agent }));
    }
    state.locks.delete(path);
    let waiter = next(state.queues, path);
    // A waiter whose agent reached its cap meanwhile is denied, and the next one is tried.
    while (waiter !== undefined && holdsOf(state, waiter.agent) >= MAX_LOCKS_PER_AGENT) {
      this.#deny('agent_cap');
      frames.push(this.#frame(sid, { action: 'deny', path_hmac: path, agent_id: waiter.agent }));
      waiter = next(state.queues, path);
    }
    if (waiter !== undefined) {
      this.#metrics
        .histogram('relay_lock_wait_ms', WAIT_BUCKETS_MS)
        .observe(Math.max(0, now - waiter.queuedAt));
      state.locks.set(path, {
        agent: waiter.agent,
        member: waiter.member,
        ttlMs: waiter.ttlMs,
        expiresAt: now + waiter.ttlMs,
      });
      frames.push(
        this.#frame(sid, {
          action: 'acquire',
          path_hmac: path,
          agent_id: waiter.agent,
          ttl_ms: waiter.ttlMs,
        }),
      );
    }
    return frames;
  }

  /** Saves `state`; a failure throws (the caller answers 503, nothing was sequenced). */
  async #save(sid: string, tx: { save(s: SessionLocks): Promise<void> }, state: SessionLocks) {
    await tx.save(state);
    this.#held.set(sid, state.locks.size);
    if (state.locks.size > 0 || state.queues.size > 0) this.#sessions.add(sid);
  }

  /** Sequences server frames; a failure is logged and counted (the state is already saved). */
  async #emit(sid: string, frames: readonly UnsequencedFrame[]): Promise<void> {
    if (frames.length === 0) return;
    try {
      await this.deps.emitter.emit(
        sid,
        frames.map((f) => f.p as Record<string, unknown>),
      );
    } catch (err) {
      this.#metrics.counter('relay_lock_emit_failures_total').inc();
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'locks.emit_failed',
      );
    }
  }

  /** Keeps a session in the sweep (a member of it joined a room on this node). */
  watch(sid: string): void {
    this.#sessions.add(sid);
  }

  /** A client's `file.lock` frame. */
  async handle(ctx: LockContext, frame: FileLockFrameIn): Promise<LockOutcome> {
    const key = `${ctx.sid}:${ctx.sender.memberId}:${frame.id}`;
    const prior = this.#recent.get(key);
    if (prior !== undefined) {
      // A resend: B041 echoes a sequenced frame's first seq; nothing changes.
      if (prior.outcome === 'granted' || prior.outcome === 'released') {
        await ctx.sequence([]).catch(() => undefined);
      }
      return prior;
    }
    const request = parse(frame.id, frame.p);
    if ('outcome' in request) return request;
    let outcome: LockOutcome | 'unsequenced';
    try {
      outcome = await this.deps.store.withSession(ctx.sid, (tx) =>
        request.action === 'acquire'
          ? this.#acquire(ctx, request, tx)
          : this.#release(ctx, request, tx),
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'service_unavailable') {
        return {
          outcome: 'refused',
          code: 'service_unavailable',
          detail: LOCK_DETAILS.unavailable,
        };
      }
      throw err;
    }
    // Sequencing refused the frame (rate limit, store down): nothing changed, and a resend is
    // handled afresh.
    if (outcome === 'unsequenced') return { outcome: 'ignored' };
    if (outcome.outcome !== 'refused') this.#remember(key, outcome);
    return outcome;
  }

  /**
   * Grants or renews under the session's lock: the state is saved first (a failed save is a 503
   * and nothing is sequenced), then the client's frame is sequenced; when sequencing refuses it,
   * the state before the grant is saved back.
   */
  async #grant(
    ctx: LockContext,
    tx: { save(s: SessionLocks): Promise<void> },
    state: SessionLocks,
    path: string,
    lock: HeldLock,
  ): Promise<LockOutcome | 'unsequenced'> {
    const before = clone(state);
    state.locks.set(path, lock);
    await this.#save(ctx.sid, tx, state);
    const stored = await ctx.sequence([]);
    if (stored === undefined) {
      await this.#save(ctx.sid, tx, before);
      return 'unsequenced';
    }
    return { outcome: 'granted' };
  }

  async #acquire(
    ctx: LockContext,
    req: LockRequest,
    tx: { load(): Promise<SessionLocks>; save(s: SessionLocks): Promise<void> },
  ): Promise<LockOutcome | 'unsequenced'> {
    const { sid, sender } = ctx;
    const state = await tx.load();
    const now = this.#clock();
    let held = state.locks.get(req.path);
    if (held !== undefined && held.expiresAt <= now) {
      // An expired lock no sweep freed yet: free it (expire, then its first waiter) first.
      const frames = this.#free(sid, state, req.path, held, now);
      await this.#save(sid, tx, state);
      await this.#emit(sid, frames);
      held = state.locks.get(req.path);
    }
    if (held !== undefined && held.agent === req.agent) {
      // The holder renews (only its member or the host may).
      if (sender.role !== 'host' && held.member !== sender.memberId) {
        return {
          outcome: 'refused',
          code: 'forbidden',
          detail: 'Only the holder may renew a lock.',
        };
      }
      return this.#grant(ctx, tx, state, req.path, {
        ...held,
        ttlMs: req.ttlMs,
        expiresAt: now + req.ttlMs,
      });
    }
    if (held !== undefined) {
      const position = enqueue(state.queues, req.path, {
        agent: req.agent,
        member: sender.memberId,
        ttlMs: req.ttlMs,
        frameId: req.frameId,
        queuedAt: now,
      } satisfies Waiter);
      const reason: DenyReason = position === null ? 'queue_full' : 'held';
      this.#deny(reason);
      this.deps.hints?.denied(sid, {
        pathHmac: req.path,
        holder: held.agent,
        requester: req.agent,
      });
      await this.#save(sid, tx, state);
      await this.#emit(sid, [
        this.#frame(sid, { action: 'deny', path_hmac: req.path, agent_id: held.agent }),
      ]);
      return position === null
        ? { outcome: 'denied', holder: held.agent, reason }
        : { outcome: 'queued', position };
    }
    // Free: the caps, then the grant.
    const reason: DenyReason | null =
      state.locks.size >= MAX_LOCKS_PER_SESSION
        ? 'session_cap'
        : holdsOf(state, req.agent) >= MAX_LOCKS_PER_AGENT
          ? 'agent_cap'
          : null;
    if (reason !== null) {
      this.#deny(reason);
      await this.#emit(sid, [
        this.#frame(sid, { action: 'deny', path_hmac: req.path, agent_id: req.agent }),
      ]);
      return { outcome: 'denied', holder: null, reason };
    }
    return this.#grant(ctx, tx, state, req.path, {
      agent: req.agent,
      member: sender.memberId,
      ttlMs: req.ttlMs,
      expiresAt: now + req.ttlMs,
    });
  }

  async #release(
    ctx: LockContext,
    req: LockRequest,
    tx: { load(): Promise<SessionLocks>; save(s: SessionLocks): Promise<void> },
  ): Promise<LockOutcome | 'unsequenced'> {
    const { sid, sender } = ctx;
    const state = await tx.load();
    const held = state.locks.get(req.path);
    if (
      held === undefined ||
      held.agent !== req.agent ||
      (sender.role !== 'host' && held.member !== sender.memberId)
    ) {
      return { outcome: 'ignored' };
    }
    const before = clone(state);
    const grants = this.#free(sid, state, req.path, null, this.#clock());
    await this.#save(sid, tx, state);
    const stored = await ctx.sequence(grants);
    if (stored === undefined) {
      await this.#save(sid, tx, before);
      return 'unsequenced';
    }
    return { outcome: 'released' };
  }

  /**
   * Frees what `match` selects in `sid` (cleanup), with `expire` frames; resolves to how many.
   * `guard`, when given, must hold on the loaded state (else nothing changes).
   */
  async #releaseWhere(
    sid: string,
    match: (holder: { agent: string; member: string }) => boolean,
    guard?: (state: SessionLocks) => boolean,
  ): Promise<number> {
    return this.deps.store.withSession(sid, async (tx) => {
      const state = await tx.load();
      if (guard !== undefined && !guard(state)) return 0;
      const dropped = dropWaiters(state.queues, match);
      const now = this.#clock();
      const frames: UnsequencedFrame[] = [];
      let freed = 0;
      for (const [path, lock] of [...state.locks]) {
        if (!match(lock)) continue;
        freed += 1;
        frames.push(...this.#free(sid, state, path, lock, now));
      }
      if (freed === 0 && dropped === 0) return 0;
      await this.#save(sid, tx, state);
      await this.#emit(sid, frames);
      return freed;
    });
  }

  /** Frees every lock of agent `agentId` in `sid` (its `agent.exit`). */
  releaseAllForAgent(sid: string, agentId: string): Promise<number> {
    return this.#releaseWhere(sid, (h) => h.agent === agentId);
  }

  /** Frees every lock of member `memberId` in `sid` (kicked). */
  releaseAllForMember(sid: string, memberId: string): Promise<number> {
    return this.#releaseWhere(sid, (h) => h.member === memberId);
  }

  /** Records that `member` has a connection on relay node `node`. */
  memberJoined(sid: string, member: string, node: string): Promise<void> {
    return this.deps.store.withSession(sid, async (tx) => {
      const state = await tx.load();
      const nodes = state.members.get(member) ?? [];
      if (nodes.includes(node) && !state.departed.has(member)) return;
      if (!nodes.includes(node)) state.members.set(member, [...nodes, node]);
      // Back: no earlier departure's grace may free its locks.
      state.departed.delete(member);
      await tx.save(state);
    });
  }

  /**
   * Records that `member` has no connection left on `node`. When it has none on any node, resolves
   * to the mark of this departure (the caller then waits LEAVE_GRACE_MS and calls `releaseIfGone`
   * with it); otherwise to undefined.
   */
  memberLeft(sid: string, member: string, node: string): Promise<string | undefined> {
    return this.deps.store.withSession(sid, async (tx) => {
      const state = await tx.load();
      const before = state.members.get(member) ?? [];
      // Not recorded here (a lost document or a failed join): no proof it is gone elsewhere.
      if (!before.includes(node)) return undefined;
      const nodes = before.filter((n) => n !== node);
      let mark: string | undefined;
      if (nodes.length > 0) state.members.set(member, nodes);
      else {
        state.members.delete(member);
        mark = newId('req');
        state.departed.set(member, mark);
      }
      await tx.save(state);
      return mark;
    });
  }

  /**
   * Frees `member`'s locks when the departure marked `mark` is still its latest and it is connected
   * nowhere (that departure's grace ended).
   */
  releaseIfGone(sid: string, member: string, mark: string): Promise<number> {
    return this.#releaseWhere(
      sid,
      (h) => h.member === member,
      (state) =>
        (state.members.get(member) ?? []).length === 0 && state.departed.get(member) === mark,
    );
  }

  /** Frees every lock of `sid` (the session ended). */
  releaseAll(sid: string): Promise<number> {
    return this.#releaseWhere(sid, () => true);
  }

  /** Frees the locks expired at `now` in the sessions this node watches; resolves to how many. */
  async sweep(now: Date): Promise<number> {
    let expired = 0;
    for (const sid of [...this.#sessions]) {
      try {
        expired += await this.deps.store.withSession(sid, async (tx) => {
          const state = await tx.load();
          if (state.locks.size === 0 && state.queues.size === 0) {
            this.#sessions.delete(sid);
            this.#held.delete(sid);
            return 0;
          }
          const frames: UnsequencedFrame[] = [];
          let n = 0;
          for (const [path, lock] of [...state.locks]) {
            if (lock.expiresAt > now.getTime()) continue;
            n += 1;
            frames.push(...this.#free(sid, state, path, lock, now.getTime()));
          }
          if (n === 0) return 0;
          await this.#save(sid, tx, state);
          await this.#emit(sid, frames);
          return n;
        });
      } catch (err) {
        this.deps.logger?.warn(
          { sid, error: err instanceof Error ? err.name : 'unknown' },
          'locks.sweep_failed',
        );
      }
    }
    if (expired > 0) this.#metrics.counter('relay_lock_expired_total').inc(expired);
    return expired;
  }
}

/** Locks `agent` holds in `state`. */
const holdsOf = (state: SessionLocks, agent: string): number =>
  [...state.locks.values()].filter((l) => l.agent === agent).length;

/** A deep copy of `state`. */
function clone(state: SessionLocks): SessionLocks {
  return {
    locks: new Map([...state.locks].map(([k, v]) => [k, { ...v }])),
    queues: new Map([...state.queues].map(([k, q]) => [k, q.map((w) => ({ ...w }))])),
    members: new Map([...state.members].map(([k, n]) => [k, [...n]])),
    departed: new Map(state.departed),
  };
}
