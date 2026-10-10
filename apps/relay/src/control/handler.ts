/**
 * The control handler (B051, CT-WS-CONTROL): a host's `control.kick`, `mute`, `unmute`, `role`,
 * `transfer_host`, `end` and `policy` frames. Each frame goes through four steps:
 *
 * 1. **Checks** (`authority.ts`), before the frame is sequenced, from fresh records. A refusal is
 *    a `sys.error` to the sender only, and nothing is sequenced.
 * 2. **Policy only:** the new policy is written before sequencing. A failed write refuses the frame
 *    (`service_unavailable`) and keeps the previous policy, so the next frame always sees the
 *    policy of the last sequenced `control.policy`.
 * 3. **Sequencing** (B041, then B044's fan-out). A frame that is not sequenced (store down: B041
 *    already answered 503) has no effect, and a policy written in step 2 is put back.
 * 4. **Effects**, only once the frame has its `seq`, so they apply to frames with a higher `seq`:
 *    - `kick`: the member is marked as left (reconnects get 4403) and its connections are closed
 *      4403 on every node. Then `control.member_left {member, code: kicked}` and
 *      `control.rotate_key {kid, reason: member_removed}` are emitted with consecutive `seq`s
 *      (B049), so nothing sequenced after the kick reaches the member. If the pair cannot be
 *      emitted, the removal is undone (the member can reconnect at once) and the host gets 503.
 *    - `mute` / `unmute`: stored, and in force on this node at once (other nodes within 2 s).
 *    - `role`: the record is updated and this node's cache read again, so the target's next frame
 *      is authorised with the new role.
 *    - `transfer_host`: one transaction swaps host and editor, then one `control.host_changed
 *      {host, code: transfer}` is emitted. If it cannot be, the swap is undone.
 *    - `end`: the session is ended (SessionStatePort), `control.session_state {state: ended}` is
 *      emitted, then every connection is closed 1000. If the frame cannot be emitted, the state
 *      is put back. Later frames on the session close 4404.
 *    - `policy`: the frame's `seq` is recorded with the stored policy.
 *
 *    An effect that fails after sequencing answers the host with `service_unavailable` (or
 *    `conflict` when the records changed in between); the sequenced frame stays in the log.
 *
 * Every frame gets exactly one audit event (B036): `control.<kind>` with the actor, the target
 * (the member, or the session) and the outcome (`success`, `denied`, or `failed`). Its meta holds
 * enums, ids and field names only, never a value from the payload beyond those. Frames B043
 * refuses before they reach this handler (non-hosts) are audited through `auditDenied`.
 *
 * A resend of a frame this node handled (same session, sender and id) has no second effect: B041
 * echoes its original `seq`.
 *
 * Owns: the order of checks, sequencing and effects, and their rollback. Must not: generate,
 * hold or see key material (the kick only asks B049 for the next epoch), or log a payload field
 * other than the kind, member ids and the outcome.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  toProblem,
  unavailable,
  type AuditEmitter,
  type AuditMetaValue,
  type ErrorCode,
  type Logger,
  type Metrics,
  type Problem,
} from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import type { RelayConnection } from '../pipeline.js';
import {
  checkAuthority,
  CONTROL_DETAILS,
  targetOf,
  type Authorised,
  type ControlKind,
  type Refusal,
} from './authority.js';
import type { MuteRegistry } from './mute-registry.js';
import { isPolicyError, policyFrom, type PolicyStore, type StoredPolicy } from './policy-store.js';
import type {
  ConnectionRegistryPort,
  MembershipPort,
  SequencerPort,
  SessionStatePort,
} from './ports.js';

/** Resends remembered per node. */
export const RECENT_FRAMES_MAX = 10_000;
/** Ended sessions remembered per node (their frames close 4404). */
export const ENDED_SESSIONS_MAX = 10_000;

/** A control frame as it reaches the handler (decoded by B039). */
export interface ControlFrameIn {
  t: 'control';
  id: string;
  sid: string;
  k: ControlKind;
  p?: unknown;
}

/** What happened to a frame. */
export type ControlOutcome =
  | { accepted: true; seqs: number[] }
  /** `error` is what the sender is told; absent when B041 already answered (not sequenced). */
  | { accepted: false; error?: Problem };

/** The sender, as the room knows them (for the audit event's actor). */
export interface ControlSender {
  /** `mem_`. */
  id: string;
  userId: string;
  workspaceId: string | null;
}

/** One frame's context: its session, sender, and the rest of the pipeline. */
export interface ControlContext {
  sid: string;
  sender: ControlSender;
  /** Runs sequencing and fan-out; the frame's `seq`, or undefined when it was not sequenced. */
  sequence(): Promise<number | undefined>;
}

/** What the handler needs. */
export interface ControlDeps {
  membership: MembershipPort;
  sessions: SessionStatePort;
  sequencer: SequencerPort;
  connections: ConnectionRegistryPort;
  mutes: MuteRegistry;
  policies: PolicyStore;
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  /** Called once a session has ended here (B047's presence, the mute cache). */
  onEnded?: (sid: string) => void;
  /** Called once `host_changed` went out (B052: held queue items show as approved again). */
  onHostChanged?: (sid: string) => void;
  /** Milliseconds since the epoch. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** A metric outcome. */
type Outcome = 'accepted' | 'denied' | 'rejected' | 'failed' | 'duplicate';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  kick: new Set(['abuse', 'inactive', 'request', 'other']),
  end: new Set(['done', 'abandoned', 'error']),
  role: new Set(['editor', 'viewer']),
};

/** The audit meta of `kind` with `p`: ids, enums and field names only. */
export function controlMeta(
  kind: ControlKind,
  sid: string,
  p: unknown,
): Record<string, AuditMetaValue> {
  const q = isRecord(p) ? p : {};
  const pick = (field: string, allowed: ReadonlySet<string>): string | null => {
    const value = q[field];
    return typeof value === 'string' && allowed.has(value) ? value : null;
  };
  switch (kind) {
    case 'control.kick':
      return { session_id: sid, code: pick('code', ENUMS['kick'] ?? new Set()) };
    case 'control.mute': {
      const until = q['until'];
      const at = typeof until === 'string' ? Date.parse(until) : Number.NaN;
      return { session_id: sid, until: Number.isFinite(at) ? new Date(at).toISOString() : null };
    }
    case 'control.unmute':
      return { session_id: sid };
    case 'control.role':
      return { session_id: sid, role: pick('role', ENUMS['role'] ?? new Set()) };
    case 'control.transfer_host':
      return { session_id: sid, code: 'transfer' };
    case 'control.end':
      return { session_id: sid, code: pick('code', ENUMS['end'] ?? new Set()) };
    case 'control.policy':
      return {
        session_id: sid,
        fields: Object.keys(q)
          .filter((f) => /^[a-z_]{1,32}$/.test(f))
          .sort()
          .join(','),
      };
  }
}

/** The audit target of `kind`: the member it names, or the session. */
export function controlTarget(kind: ControlKind, sid: string, p: unknown) {
  const member = targetOf(kind, p);
  return member !== undefined && /^mem_[0-9A-HJKMNP-TV-Z]{26}$/.test(member.id)
    ? { type: 'session_member', id: member.id }
    : { type: 'session', id: sid };
}

/** The handler and what the stage and B043 need around it. */
export interface ControlHandler {
  handleControlFrame(ctx: ControlContext, frame: ControlFrameIn): Promise<ControlOutcome>;
  /** True once `sid` ended through this node (its frames close 4404). */
  hasEnded(sid: string): boolean;
  /** Audits a control frame B043 refused before it got here (the sender is not the host). */
  auditDenied(sid: string, sender: ControlSender, kind: ControlKind, p: unknown): void;
}

/** The handler over `deps`. */
export function createControlHandler(deps: ControlDeps): ControlHandler {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  const recent = new Map<string, Promise<ControlOutcome>>();
  const ended = new Set<string>();

  const remember = <T>(set: Map<string, T> | Set<string>, max: number): void => {
    while (set.size > max) {
      const oldest = set.keys().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  };

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
    toProblem(unavailable(1, CONTROL_DETAILS.unavailable), { requestId: newId('req') });

  function audit(
    kind: ControlKind,
    sid: string,
    sender: ControlSender,
    p: unknown,
    outcome: 'success' | 'denied' | 'failed',
  ): void {
    deps.audit?.emitDetached({
      workspaceId: sender.workspaceId,
      actor: { type: 'user', id: sender.userId },
      action: kind,
      target: controlTarget(kind, sid, p),
      outcome,
      meta: controlMeta(kind, sid, p),
    });
  }

  function count(kind: ControlKind, outcome: Outcome, sid: string, sender: string): void {
    metrics.counter('relay_control_frames_total', { kind, outcome }).inc();
    deps.logger?.info({ sid, member: sender, kind, result: outcome }, 'relay.control_frame');
  }

  /** A refusal before sequencing. */
  function refused(ctx: ControlContext, frame: ControlFrameIn, refusal: Refusal): ControlOutcome {
    count(frame.k, refusal.code === 'forbidden' ? 'denied' : 'rejected', ctx.sid, ctx.sender.id);
    audit(frame.k, ctx.sid, ctx.sender, frame.p, 'denied');
    return { accepted: false, error: problem(refusal.code, refusal.detail, refusal.pointer) };
  }

  /** A failure (records unreadable, an effect that could not be applied). */
  function failed(ctx: ControlContext, frame: ControlFrameIn, error?: Problem): ControlOutcome {
    count(frame.k, 'failed', ctx.sid, ctx.sender.id);
    audit(frame.k, ctx.sid, ctx.sender, frame.p, 'failed');
    return error === undefined ? { accepted: false } : { accepted: false, error };
  }

  const settle = (task: Promise<unknown>, what: string, sid: string): Promise<void> =>
    task.then(
      () => undefined,
      (err: unknown) => {
        deps.logger?.error(
          { sid, reason: what, error: err instanceof Error ? err.name : typeof err },
          'relay.control_rollback_failed',
        );
      },
    );

  /** The effects of an accepted, sequenced frame; the further `seq`s it emitted. */
  async function apply(
    ctx: ControlContext,
    frame: ControlFrameIn,
    auth: Authorised,
    seq: number,
    policy: StoredPolicy | undefined,
  ): Promise<number[] | Problem> {
    const { sid } = ctx;
    const target = auth.target ?? '';
    const p = isRecord(frame.p) ? frame.p : {};
    switch (frame.k) {
      case 'control.kick': {
        const removed = await deps.membership.remove(sid, target, new Date(clock()));
        await deps.connections.refresh(sid, target).catch(() => undefined);
        // Closed before the pair goes out: nothing sequenced after the kick reaches the member.
        await deps.connections.closeMember(sid, target, CloseCode.Forbidden);
        try {
          const pair = await deps.sequencer.emitWithRotation(sid, {
            kind: 'control.member_left',
            t: 'control',
            p: { member: target, code: 'kicked' },
          });
          return pair.seqs;
        } catch {
          // Undone: the member may reconnect at once.
          if (removed) await settle(deps.membership.restore(sid, target), 'kick', sid);
          await deps.connections.refresh(sid, target).catch(() => undefined);
          return unavailableProblem();
        }
      }
      case 'control.mute':
        await deps.mutes.mute(sid, target, auth.until ?? null);
        return [];
      case 'control.unmute':
        await deps.mutes.unmute(sid, target);
        return [];
      case 'control.role': {
        const role = p['role'] === 'viewer' ? 'viewer' : 'editor';
        if (!(await deps.membership.setRole(sid, target, role))) {
          return problem('conflict', CONTROL_DETAILS.changed, '/p/member');
        }
        await deps.connections.refresh(sid, target).catch(() => undefined);
        return [];
      }
      case 'control.transfer_host': {
        const host = ctx.sender.id;
        if (!(await deps.membership.transferHost(sid, host, target))) {
          return problem('conflict', CONTROL_DETAILS.changed, '/p/to');
        }
        let emitted: number;
        try {
          emitted = await deps.sequencer.emit(sid, {
            kind: 'control.host_changed',
            t: 'control',
            p: { host: target, code: 'transfer' },
          });
        } catch {
          await settle(deps.membership.transferHost(sid, target, host), 'transfer_host', sid);
          return unavailableProblem();
        } finally {
          await deps.connections.refresh(sid, host).catch(() => undefined);
          await deps.connections.refresh(sid, target).catch(() => undefined);
        }
        deps.onHostChanged?.(sid);
        return [emitted];
      }
      case 'control.end': {
        const previous = await deps.sessions.end(sid, new Date(clock()));
        if (previous === null) return problem('session_ended', CONTROL_DETAILS.ended);
        let emitted: number;
        try {
          emitted = await deps.sequencer.emit(sid, {
            kind: 'control.session_state',
            t: 'control',
            p: { state: 'ended' },
          });
        } catch {
          await settle(deps.sessions.restore(sid, previous), 'end', sid);
          return unavailableProblem();
        }
        ended.add(sid);
        remember(ended, ENDED_SESSIONS_MAX);
        deps.onEnded?.(sid);
        const members = new Set(await deps.membership.members(sid).catch(() => []));
        members.add(ctx.sender.id);
        await Promise.all(
          [...members].map((mid) =>
            deps.connections.closeMember(sid, mid, CloseCode.Normal).catch(() => undefined),
          ),
        );
        return [emitted];
      }
      case 'control.policy':
        if (policy !== undefined) {
          await settle(deps.policies.set(sid, policy.policy, seq), 'policy_seq', sid);
        }
        return [];
    }
  }

  async function run(ctx: ControlContext, frame: ControlFrameIn): Promise<ControlOutcome> {
    let auth: Authorised | Refusal;
    try {
      auth = await checkAuthority(
        { membership: deps.membership, connections: deps.connections, clock },
        ctx.sid,
        ctx.sender.id,
        frame.k,
        frame.p,
      );
    } catch {
      return failed(ctx, frame, unavailableProblem());
    }
    if (auth.refused) return refused(ctx, frame, auth);

    // Policy: written before sequencing, so a store failure refuses the frame.
    let previous: StoredPolicy | undefined;
    let next: StoredPolicy | undefined;
    if (frame.k === 'control.policy') {
      try {
        previous = await deps.policies.read(ctx.sid);
      } catch {
        return failed(ctx, frame, unavailableProblem());
      }
      const policy = policyFrom(frame.p, previous.policy);
      if (isPolicyError(policy)) {
        return refused(ctx, frame, {
          refused: true,
          code: 'invalid_frame',
          detail: CONTROL_DETAILS.policy,
          pointer: policy.pointer,
        });
      }
      next = { policy, updatedSeq: null };
      try {
        await deps.policies.set(ctx.sid, policy, null);
      } catch {
        return failed(ctx, frame, unavailableProblem());
      }
    }

    let seq: number | undefined;
    try {
      seq = await ctx.sequence();
    } catch {
      seq = undefined;
    }
    if (seq === undefined) {
      if (previous !== undefined) {
        await settle(
          deps.policies.set(ctx.sid, previous.policy, previous.updatedSeq),
          'policy',
          ctx.sid,
        );
      }
      return failed(ctx, frame);
    }

    let result: number[] | Problem;
    try {
      result = await apply(ctx, frame, auth, seq, next);
    } catch {
      result = unavailableProblem();
    }
    if (!Array.isArray(result)) return failed(ctx, frame, result);
    count(frame.k, 'accepted', ctx.sid, ctx.sender.id);
    audit(frame.k, ctx.sid, ctx.sender, frame.p, 'success');
    return { accepted: true, seqs: [seq, ...result] };
  }

  return {
    async handleControlFrame(ctx, frame) {
      const key = `${ctx.sid}:${ctx.sender.id}:${frame.id}`;
      const earlier = recent.get(key);
      if (earlier !== undefined) {
        const outcome = await earlier;
        if (outcome.accepted) {
          // A resend: B041 echoes the original seq; nothing is applied again.
          await ctx.sequence().catch(() => undefined);
          count(frame.k, 'duplicate', ctx.sid, ctx.sender.id);
          return outcome;
        }
      }
      const task = run(ctx, frame);
      recent.set(key, task);
      remember(recent, RECENT_FRAMES_MAX);
      const outcome = await task;
      // Only an accepted frame is a duplicate when sent again; a refused one is checked anew.
      if (!outcome.accepted && recent.get(key) === task) recent.delete(key);
      return outcome;
    },
    hasEnded: (sid) => ended.has(sid),
    auditDenied(sid, sender, kind, p) {
      count(kind, 'denied', sid, sender.id);
      audit(kind, sid, sender, p, 'denied');
    },
  };
}

/** Sends `problem` to `conn` as a `sys.error` about the frame `ref`. */
export function sendControlError(conn: RelayConnection, problem: Problem, ref: string): void {
  conn.send({ v: 1, t: 'sys.error', ref, p: problem });
}
