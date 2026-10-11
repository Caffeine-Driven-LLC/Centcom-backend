/**
 * Approval routing (B060, CT-WS-SESSION-EVENTS `approval.request` / `approval.decision`, CT-RBAC
 * "Approve tool calls"). Reads only the cleartext `p` (ids, risk, approver, expiry, decision,
 * scope); the summary, command, cwd and reason stay in `ct`.
 *
 * - **Request:** from the host, or the member who owns the agent (B057's registry). `expires_at`
 *   must be in the future and at most 24 h ahead (CT-WS-SESSION-EVENTS "Limits"), else
 *   `invalid_frame`. The approval is stored (`SET NX` on its id), the frame sequenced, and the
 *   notification dispatcher told once per approval id (`NotifyPort.approvalNeeded`, ids and the
 *   risk only); a resend of the same frame is passed on for the sequencer to ack again, nothing
 *   else. A failing notification never stops the request (counted).
 * - **Decision:** deciders are authorised from live membership (never the frame or the ticket):
 *   viewers never; the host always; members in `control.policy.approvers`; and the roles the
 *   request's `approver` names (`owner`: workspace owner or admin members, `any_editor`: editors;
 *   `host`: nobody else). The requester cannot decide their own request unless they are the host.
 *   A refusal is `forbidden`, audited (`permission.denied`). The first decision claims the
 *   approval (`SET NX`) and is the only one sequenced; a later one is `forbidden`, an exact resend
 *   is acked again. At or after `expires_at` a decision is refused `gone`. `scope` is forwarded as
 *   it is: the relay remembers no scopes and answers nothing on its own.
 * - **Expiry:** `sweep` (expiry.ts) sequences the one server deny per expired approval.
 * - **Cleanup:** `cancelForAgent` (`agent.exit`) and `cancelForMember` (the requester was kicked
 *   or muted) drop pending approvals without a deny.
 *
 * Owns: routing and authorising approvals. Must not: auto-approve, read `ct`, or put anything but
 * ids and enums in a notification.
 */
import { isId, validateEvent } from '@centcom/contracts';
import { AppError, noopMetrics, type AuditEmitter, type Logger, type Metrics } from '@centcom/core';
import { sweepSession } from './expiry.js';
import {
  APPROVAL_KEY_GRACE_MS,
  APPROVERS,
  DECISIONS,
  MAX_EXPIRY_AHEAD_MS,
  RISKS,
  SCOPES,
  type AgentOwnerPort,
  type ApprovalContext,
  type ApprovalEmitter,
  type ApprovalFrame,
  type ApprovalResult,
  type ApprovalStore,
  type Approver,
  type Decider,
  type DecisionClaim,
  type DeciderPort,
  type NotifyPort,
  type PendingApproval,
  type Risk,
} from './ports.js';

/** Buckets of `relay_approval_decision_latency_ms`: a second to a day. */
const LATENCY_BUCKETS_MS = [1_000, 10_000, 60_000, 300_000, 600_000, 3_600_000, 86_400_000];
/** The in-flight key of `frameId` from the context's sender. */
const flightKey = (ctx: ApprovalContext, frameId: string): string =>
  `${ctx.sid}/${ctx.sender.memberId}/${frameId}`;
/** Workspace roles that count as the `owner` approver (CT-WS-SESSION-EVENTS "`approver` meaning"). */
const OWNER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** What the router needs. */
export interface ApprovalRouterDeps {
  store: ApprovalStore;
  deciders: DeciderPort;
  agents: AgentOwnerPort;
  notify: NotifyPort;
  emitter: ApprovalEmitter;
  /** Refused decisions are audited (`permission.denied`). */
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const refused = (code: 'invalid_frame' | 'forbidden' | 'not_found' | 'gone', detail: string) =>
  ({ outcome: 'refused', code, detail }) as const;

/** Routes approvals. */
export class ApprovalRouter {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  /** Copies of a frame on their way to the sequencer on this node (`sid/member/frame` -> count). */
  readonly #inFlight = new Map<string, number>();
  /** Sessions the sweep covers, with their pending count at the last look. */
  readonly #watched = new Map<string, number>();

  constructor(private readonly deps: ApprovalRouterDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Includes `sid` in the sweep (a member joined it on this node). */
  watch(sid: string): void {
    if (!this.#watched.has(sid)) this.#watched.set(sid, 0);
  }

  /** Pending approvals in the watched sessions, as last seen (`relay_approvals_pending`). */
  pendingCount(): number {
    let n = 0;
    for (const count of this.#watched.values()) n += count;
    return n;
  }

  /** An `approval.request` from `ctx.sender`. */
  async onRequest(ctx: ApprovalContext, frame: ApprovalFrame): Promise<ApprovalResult> {
    try {
      return await this.#request(ctx, frame);
    } catch (err) {
      return this.#failure(err);
    }
  }

  /** An `approval.decision` from `ctx.sender`. */
  async onDecision(ctx: ApprovalContext, frame: ApprovalFrame): Promise<ApprovalResult> {
    try {
      return await this.#decision(ctx, frame);
    } catch (err) {
      return this.#failure(err);
    }
  }

  /**
   * Sequences the timeout deny of every expired approval in the watched sessions; how many. A
   * session with nothing pending stops being watched unless `keep` says it still has a room here.
   */
  async sweep(now: Date, keep: (sid: string) => boolean = () => true): Promise<number> {
    let denied = 0;
    for (const sid of [...this.#watched.keys()]) {
      try {
        const result = await sweepSession(this.deps, sid, now);
        denied += result.denied;
        if (result.pending === 0 && !keep(sid)) this.#watched.delete(sid);
        else this.#watched.set(sid, result.pending);
      } catch {
        // Redis is down: the next sweep tries again.
      }
    }
    return denied;
  }

  /** Drops `agentId`'s pending approvals in `sid` without a deny (its `agent.exit`); how many. */
  cancelForAgent(sid: string, agentId: string): Promise<number> {
    return this.#cancel(sid, (a) => a.agentId === agentId);
  }

  /** Drops the pending approvals `memberId` requested in `sid` (kicked or muted); how many. */
  cancelForMember(sid: string, memberId: string): Promise<number> {
    return this.#cancel(sid, (a) => a.requester === memberId);
  }

  async #cancel(sid: string, match: (a: PendingApproval) => boolean): Promise<number> {
    const ids = (await this.deps.store.list(sid)).filter(match).map((a) => a.approvalId);
    await this.deps.store.remove(sid, ids);
    return ids.length;
  }

  #failure(err: unknown): ApprovalResult {
    if (err instanceof AppError && err.code === 'service_unavailable') {
      return { outcome: 'refused', code: 'service_unavailable', detail: err.message };
    }
    this.deps.logger?.warn(
      { error: err instanceof Error ? err.name : 'unknown' },
      'approvals.route_failed',
    );
    return {
      outcome: 'refused',
      code: 'service_unavailable',
      detail: 'Approvals cannot be routed right now; try again shortly.',
    };
  }

  async #request(ctx: ApprovalContext, frame: ApprovalFrame): Promise<ApprovalResult> {
    const p = frame.p;
    if (
      !validateEvent('approval.request', p, { mode: 'tolerant' }).ok ||
      !isRecord(p) ||
      !isId('apr', p['approval_id']) ||
      !isId('agt', p['agent_id']) ||
      typeof p['risk'] !== 'string' ||
      !RISKS.has(p['risk']) ||
      typeof p['approver'] !== 'string' ||
      !APPROVERS.has(p['approver']) ||
      typeof p['expires_at'] !== 'string'
    ) {
      return refused('invalid_frame', 'The approval request is malformed.');
    }
    const sid = ctx.sid;
    const me = ctx.sender.memberId;
    const approvalId = p['approval_id'] as string;
    // A resend first (before the bounds: by now its expiry may have passed). A decided approval
    // id is never asked again (its claim outlives the request), but its own frame is acked again.
    const decided = await this.deps.store.claimOf(sid, approvalId);
    if (decided !== null) return this.#decidedRequest(ctx, decided, frame);
    const recorded = await this.deps.store.get(sid, approvalId);
    if (recorded !== null) return this.#resent(ctx, recorded, frame, true);
    const now = this.#clock();
    const expires = Date.parse(p['expires_at']);
    if (!Number.isFinite(expires) || expires <= now) {
      return refused('invalid_frame', 'expires_at must be in the future.');
    }
    if (expires - now > MAX_EXPIRY_AHEAD_MS) {
      return refused('invalid_frame', 'expires_at must be at most 24 hours ahead.');
    }
    const agentId = p['agent_id'] as string;
    if (ctx.sender.role !== 'host') {
      const owner = await this.deps.agents.ownerOf(sid, agentId);
      if (owner !== me) {
        return refused('forbidden', "Only the host or the agent's owner may ask for an approval.");
      }
    }
    const pending: PendingApproval = {
      approvalId,
      agentId,
      requester: me,
      risk: p['risk'] as Risk,
      approver: p['approver'] as Approver,
      // Stored normalised: never the client's string as sent.
      expiresAt: new Date(expires).toISOString(),
      requestedAt: now,
      requestSeq: 0,
      frameId: frame.id,
    };
    // On its way from here on: a resend arriving meanwhile is answered by this one's echo.
    const key = flightKey(ctx, frame.id);
    this.#enter(key);
    try {
      return await this.#firstRequest(ctx, pending, frame);
    } finally {
      this.#leave(key);
    }
  }

  /** A new request's first attempt (in flight). */
  async #firstRequest(
    ctx: ApprovalContext,
    pending: PendingApproval,
    frame: ApprovalFrame,
  ): Promise<ApprovalResult> {
    const sid = ctx.sid;
    const approvalId = pending.approvalId;
    const existing = await this.deps.store.create(sid, pending, this.#ttl(pending));
    if (existing !== null) {
      // Another copy of this frame on its way here created it: its echo is the ack.
      if ((this.#inFlight.get(flightKey(ctx, frame.id)) ?? 0) > 1) return { outcome: 'duplicate' };
      return this.#resent(ctx, existing, frame, false);
    }
    // A decision that slipped in between the checks and the create: the id is decided.
    const late = await this.deps.store.claimOf(sid, approvalId);
    if (late !== null) {
      await this.deps.store.remove(sid, [approvalId]).catch(() => undefined);
      return this.#decidedRequest(ctx, late, frame);
    }
    const stored = await ctx.sequence();
    if (typeof stored !== 'object') {
      // Refused before the store was asked: never stored, forget it (unless a resend on another
      // node got it recorded meanwhile). Unknown: keep it for a resend.
      if (stored === undefined) {
        const now2 = await this.deps.store.get(sid, approvalId).catch(() => null);
        if (now2 !== null && now2.requestSeq === 0) {
          await this.deps.store.remove(sid, [approvalId]).catch(() => undefined);
        }
      }
      return { outcome: 'ignored' };
    }
    // `duplicate` here: an earlier attempt was stored but its outcome got lost; it counts now,
    // unless a resend on another node recorded it first.
    if (stored.duplicate) {
      const now2 = await this.deps.store.get(sid, approvalId).catch(() => null);
      if (now2 !== null && now2.requestSeq > 0) return { outcome: 'sequenced' };
    }
    await this.#accepted(sid, pending, stored.frame.seq);
    return { outcome: 'sequenced' };
  }

  /** The approval id is recorded: its own frame again is a resend; anything else is refused. */
  async #resent(
    ctx: ApprovalContext,
    existing: PendingApproval,
    frame: ApprovalFrame,
    checkFlight: boolean,
  ): Promise<ApprovalResult> {
    if (existing.frameId !== frame.id || existing.requester !== ctx.sender.memberId) {
      return refused('invalid_frame', 'This approval_id is already in use.');
    }
    // The same frame must say the same: its copy may be the one the log keeps.
    const p = frame.p as Record<string, unknown>;
    const expires = Date.parse(String(p['expires_at']));
    if (
      p['agent_id'] !== existing.agentId ||
      p['risk'] !== existing.risk ||
      p['approver'] !== existing.approver ||
      !Number.isFinite(expires) ||
      new Date(expires).toISOString() !== existing.expiresAt
    ) {
      return refused('invalid_frame', 'A resent request must repeat the original.');
    }
    // A resend while the original is on its way here: the original's echo is the ack.
    if (checkFlight && this.#inFlight.has(flightKey(ctx, frame.id))) {
      return { outcome: 'duplicate' };
    }
    // The original was sequenced (the sequencer acks the resend again), or its outcome is
    // unknown: the sequencer says which. A refused resend says nothing about the original, so the
    // record stays.
    const again = await this.#sequenceOnce(ctx, frame.id);
    if (typeof again !== 'object') return { outcome: 'ignored' };
    if (existing.requestSeq === 0) await this.#accepted(ctx.sid, existing, again.frame.seq);
    return { outcome: 'duplicate' };
  }

  #enter(key: string): void {
    this.#inFlight.set(key, (this.#inFlight.get(key) ?? 0) + 1);
  }

  #leave(key: string): void {
    const n = (this.#inFlight.get(key) ?? 1) - 1;
    if (n > 0) this.#inFlight.set(key, n);
    else this.#inFlight.delete(key);
  }

  /** Sequences `frameId` with this node knowing it is on its way meanwhile. */
  async #sequenceOnce(
    ctx: ApprovalContext,
    frameId: string,
  ): Promise<Awaited<ReturnType<ApprovalContext['sequence']>>> {
    const key = flightKey(ctx, frameId);
    this.#enter(key);
    try {
      return await ctx.sequence();
    } finally {
      this.#leave(key);
    }
  }

  /** A request for a decided approval id: its own frame again is acked again; else refused. */
  async #decidedRequest(
    ctx: ApprovalContext,
    decided: DecisionClaim,
    frame: ApprovalFrame,
  ): Promise<ApprovalResult> {
    if (decided.requestFrame === frame.id && decided.requester === ctx.sender.memberId) {
      await ctx.sequence();
      return { outcome: 'duplicate' };
    }
    return refused('invalid_frame', 'This approval_id was already decided.');
  }

  /** How long a request's key lives: until its expiry and a minute more. */
  #ttl(a: PendingApproval): number {
    return Math.max(1, Date.parse(a.expiresAt) + APPROVAL_KEY_GRACE_MS - this.#clock());
  }

  /** A request is in the log at `seq`: record it, count it, notify once. */
  async #accepted(sid: string, a: PendingApproval, seq: number): Promise<void> {
    if (this.#watched.has(sid)) this.#watched.set(sid, (this.#watched.get(sid) ?? 0) + 1);
    await this.deps.store
      .update(sid, { ...a, requestSeq: seq }, this.#ttl(a))
      .catch(() => undefined);
    try {
      this.deps.notify.approvalNeeded(sid, {
        approvalId: a.approvalId,
        agentId: a.agentId,
        risk: a.risk,
        approver: a.approver,
        requester: a.requester,
      });
    } catch (err) {
      this.#metrics.counter('relay_approval_notify_failures_total').inc();
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'approvals.notify_failed',
      );
    }
  }

  async #decision(ctx: ApprovalContext, frame: ApprovalFrame): Promise<ApprovalResult> {
    const p = frame.p;
    if (
      !validateEvent('approval.decision', p, { mode: 'tolerant' }).ok ||
      !isRecord(p) ||
      !isId('apr', p['approval_id']) ||
      typeof p['decision'] !== 'string' ||
      !DECISIONS.has(p['decision']) ||
      typeof p['scope'] !== 'string' ||
      !SCOPES.has(p['scope'])
    ) {
      return refused('invalid_frame', 'The approval decision is malformed.');
    }
    const sid = ctx.sid;
    const approvalId = p['approval_id'] as string;
    const me = ctx.sender.memberId;
    const now = this.#clock();
    // A decision already claimed (this frame's own earlier copy, or someone else's).
    const held = await this.deps.store.claimOf(sid, approvalId);
    if (held !== null) return this.#taken(ctx, approvalId, held, me, frame.id);
    const pending = await this.deps.store.get(sid, approvalId);
    if (pending === null) return refused('not_found', 'No pending approval has this id.');
    const claim: DecisionClaim = {
      by: me,
      frameId: frame.id,
      at: now,
      requestFrame: pending.frameId,
      requester: pending.requester,
      expiresAt: pending.expiresAt,
    };
    if (now >= Date.parse(pending.expiresAt)) {
      return refused('gone', 'This approval expired.');
    }
    const decider = await this.deps.deciders.get(sid, me);
    if (
      decider === null ||
      !mayDecide(decider, me, pending, await this.deps.deciders.approvers(sid))
    ) {
      if (decider !== null) this.#auditDenied(sid, decider);
      return refused('forbidden', 'You may not decide this approval.');
    }
    const won = await this.deps.store.claim(sid, approvalId, claim);
    if (won !== true) return this.#taken(ctx, approvalId, won, me, frame.id);
    // If sequencing throws, the claim stays: the decision may have gone out, and a second one
    // must never follow it (the sweep tidies the entry away without a deny).
    const stored = await this.#sequenceOnce(ctx, frame.id);
    if (typeof stored !== 'object') {
      // Refused before the store was asked: give the claim back. Unknown: it may be in the log,
      // so the claim stays (a second decision must never follow one that may have gone out).
      if (stored === undefined) {
        await this.deps.store.release(sid, approvalId, claim).catch(() => undefined);
      }
      return { outcome: 'ignored' };
    }
    // `duplicate` here: an earlier attempt was stored but its outcome got lost; it counts now.
    await this.deps.store.settle(sid, approvalId, claim, stored.frame.seq).catch(() => undefined);
    this.#metrics
      .histogram('relay_approval_decision_latency_ms', LATENCY_BUCKETS_MS)
      .observe(Math.max(0, this.#clock() - pending.requestedAt));
    const left = this.#watched.get(sid);
    if (left !== undefined && left > 0) this.#watched.set(sid, left - 1);
    await this.deps.store.remove(sid, [approvalId]).catch(() => undefined);
    return { outcome: 'sequenced' };
  }

  /**
   * The approval is claimed already. Its own frame again is a resend: while the original is on its
   * way on this node its echo answers; otherwise the sequencer acks it again (then it is settled).
   * A refused resend keeps the claim: it says nothing about the original. Past the approval's
   * expiry, an unsettled one is refused `gone` (its copy must not be the first in the log).
   * Anything else is a later decision: refused.
   */
  async #taken(
    ctx: ApprovalContext,
    approvalId: string,
    held: DecisionClaim,
    me: string,
    frameId: string,
  ): Promise<ApprovalResult> {
    if (held.by !== me || held.frameId !== frameId) {
      return refused('forbidden', 'This approval was already decided.');
    }
    if (held.seq === undefined) {
      if (this.#inFlight.has(flightKey(ctx, frameId))) return { outcome: 'duplicate' };
      if (held.expiresAt !== undefined && this.#clock() >= Date.parse(held.expiresAt)) {
        return refused('gone', 'This approval expired.');
      }
    }
    const again = await this.#sequenceOnce(ctx, frameId);
    if (held.seq === undefined) {
      // A refused resend says nothing about the original: the claim stays.
      if (typeof again !== 'object') return { outcome: 'ignored' };
      await this.deps.store
        .settle(ctx.sid, approvalId, held, again.frame.seq)
        .catch(() => undefined);
      await this.deps.store.remove(ctx.sid, [approvalId]).catch(() => undefined);
    }
    return { outcome: 'duplicate' };
  }

  #auditDenied(sid: string, decider: Decider): void {
    this.deps.audit?.emitDetached({
      workspaceId: decider.workspaceId,
      actor: { type: 'user', id: decider.userId },
      action: 'permission.denied',
      target: { type: 'session', id: sid },
      outcome: 'denied',
      meta: { attempted: 'approval.decision', reason: 'approver', session_id: sid },
    });
  }
}

/**
 * Whether `decider` (member `me`) may decide `pending` (CT-WS-SESSION-EVENTS "Who may send
 * `approval.decision`", within CT-RBAC's roles): viewers never; the host always; nobody else on
 * their own request; members in `control.policy.approvers`; then the roles the request's
 * `approver` names.
 */
export function mayDecide(
  decider: Pick<Decider, 'role' | 'workspaceRole'>,
  me: string,
  pending: Pick<PendingApproval, 'requester' | 'approver'>,
  approvers: readonly string[],
): boolean {
  if (decider.role === 'viewer') return false;
  if (decider.role === 'host') return true;
  if (me === pending.requester) return false;
  if (approvers.includes(me)) return true;
  switch (pending.approver) {
    case 'host':
      return false;
    case 'any_editor':
      return decider.role === 'editor';
    case 'owner':
      return decider.workspaceRole !== null && OWNER_ROLES.has(decider.workspaceRole);
  }
}
