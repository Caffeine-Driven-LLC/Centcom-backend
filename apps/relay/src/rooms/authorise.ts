/**
 * Room membership and frame authorisation (B043): the handshake's `onAdmitted` hook that puts a
 * welcomed member in their session's room, the authorise stage (pipeline order 20), and the
 * reaction to `centcom:membership` events.
 *
 * - **Join** (`onAdmitted`, before the welcome): the member's live record (just read by
 *   `SessionAccess`) and the room's cap (`max_session_members`, at most 50; a member's further
 *   devices are not counted again; the cap is checked again here, synchronously with the join, so
 *   concurrent hellos cannot pass it together). The connection leaves the room when it closes.
 * - **Authorise** (order 20, after the handshake): `sys.*` and `ack` frames pass untouched. Every
 *   `event`, `queue`, `control` and `presence` frame is checked against the member's live role
 *   (at most 2 s old, CT-RBAC rule 2; never the ticket's or the frame's) with `authorizeFrame`:
 *   - allowed: on to the next stage;
 *   - muted (`event`/`queue` of a muted member): dropped silently;
 *   - forbidden: `sys.error` `forbidden` (with `ref` the frame's id) to the sender only, one
 *     `permission.denied` audit event (meta: the kind and why, never `p` or `ct`), not sequenced;
 *   - no longer a member: the member's connections close 4403 (`not_a_member`);
 *   - the records cannot be read: `sys.error` `service_unavailable` with `retry_after_s` (fail
 *     closed), the frame dropped, the connection kept.
 * - **Membership events**: `removed` and `left` close the user's connections in that workspace's
 *   sessions with 4403 at once; `role_changed` drops the user's cached roles and re-reads them
 *   right away (closing those the new role keeps out of sessions). Losing the subscription is
 *   covered by the 2 s re-check; subscribing is retried with backoff.
 *
 * Logs carry the kind, session, member and outcome only.
 *
 * Owns: joining rooms and authorising frames. Must not: read `p` or `ct`, decide content-level
 * permissions (which agent a frame is for), or log a frame.
 */
import { isId, newId } from '@centcom/contracts';
import {
  AppError,
  MEMBERSHIP_EVENTS_CHANNEL,
  noopMetrics,
  toProblem,
  unavailable,
  type AuditEmitter,
  type Logger,
  type MembershipEvent,
  type Metrics,
  type PubSub,
  type Unsubscribe,
} from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import type { AdmissionDecision, AdmittedHello } from '../handshake/handshake.js';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import { roomHasSpace } from './access.js';
import {
  authorizeFrame,
  MEMBER_FRAME_TYPES,
  SERVER_ONLY_KINDS,
  type FrameKind,
  type MuteState,
} from './kind-policy.js';
import type { LiveMembership } from './membership.js';
import type { RoomRegistry, RoomTimer } from './registry.js';

/** The first resubscribe waits this long; each later one twice as long, at most a minute. */
export const RESUBSCRIBE_BASE_MS = 1_000;
export const RESUBSCRIBE_MAX_MS = 60_000;

/** The details of the stage's refusals (GUIDELINES §3.4). */
export const ROOM_DETAILS = Object.freeze({
  forbidden: 'Your role in this session does not allow that frame.',
  notJoined: 'This connection is not in a session room.',
  notAMember: 'You are no longer a member of this session.',
  full: 'The session already has as many members as its plan allows.',
  unavailable: 'The relay cannot check your role right now; try again shortly.',
} as const);

/** What the room side needs. */
export interface RoomsDeps {
  registry: RoomRegistry;
  membership: LiveMembership;
  mute: MuteState;
  /** B036's emitter: denied frames are audited in the background. */
  audit?: Pick<AuditEmitter, 'emitDetached'>;
  logger?: Logger;
  metrics?: Metrics;
  /** Runs `fn` after `ms` (resubscribe backoff); default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => RoomTimer;
}

const defaultTimer = (fn: () => void, ms: number): RoomTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** A membership event from the channel, or null for anything malformed. */
export function parseMembershipEvent(message: string): MembershipEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Partial<Record<keyof MembershipEvent, unknown>>;
  if (e.type !== 'role_changed' && e.type !== 'removed' && e.type !== 'left') return null;
  if (!isId('wsp', e.wsp) || !isId('mem', e.mem) || !isId('usr', e.user)) return null;
  return {
    type: e.type,
    wsp: e.wsp,
    mem: e.mem,
    user: e.user,
    ...(typeof e.role === 'string' ? { role: e.role as MembershipEvent['role'] } : {}),
    at: typeof e.at === 'string' ? e.at : '',
  };
}

/** The room side: the handshake hook, the stage and the membership listener. */
export function createRooms(deps: RoomsDeps): {
  onAdmitted: (connection: RelayConnection, admitted: AdmittedHello) => Promise<AdmissionDecision>;
  stage: InboundStage;
  onMembershipEvent: (event: MembershipEvent) => Promise<void>;
  listen: (pubsub: Pick<PubSub, 'subscribe'>) => { stop(): Promise<void> };
} {
  const { registry, membership } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  const setTimer = deps.setTimer ?? defaultTimer;

  const sysError = (connection: RelayConnection, error: AppError, ref?: string): void => {
    connection.send({
      v: 1,
      t: 'sys.error',
      ...(ref === undefined ? {} : { ref }),
      p: toProblem(error, { requestId: newId('req') }),
    });
  };

  async function onAdmitted(
    connection: RelayConnection,
    admitted: AdmittedHello,
  ): Promise<AdmissionDecision> {
    const { sid, access } = admitted;
    const mid = access.member.id;
    const live = await membership.get(sid, mid);
    if (live === null) return { ok: false, code: 'not_a_member', detail: ROOM_DETAILS.notAMember };
    const room = registry.getOrCreate(sid);
    if (!roomHasSpace(room, mid, access.session.maxMembers)) {
      metrics.counter('relay_room_joins_total', { outcome: 'full' }).inc();
      return { ok: false, code: 'session_full', detail: ROOM_DETAILS.full };
    }
    room.join(connection, {
      id: mid,
      sid,
      role: live.role,
      userId: live.userId,
      workspaceId: live.workspaceId,
      name: access.member.name,
      slot: access.member.slot,
    });
    connection.onClose(() => registry.locate(connection)?.room.leave(connection));
    metrics.counter('relay_room_joins_total', { outcome: 'joined' }).inc();
    return { ok: true };
  }

  const stage: InboundStage = async (fc, next) => {
    const frame = fc.frame as (FrameKind & { id?: string }) | undefined;
    if (frame === undefined || !MEMBER_FRAME_TYPES.has(frame.t)) {
      await next();
      return;
    }
    const { connection } = fc;
    const ref = typeof frame.id === 'string' ? frame.id : undefined;
    const where = registry.locate(connection);
    if (where === undefined) {
      metrics.counter('relay_frames_authorised_total', { outcome: 'not_joined' }).inc();
      sysError(connection, new AppError('forbidden', { detail: ROOM_DETAILS.notJoined }), ref);
      return;
    }
    const { room, member } = where;
    let live;
    try {
      live = await membership.get(room.sid, member.id);
    } catch {
      metrics.counter('relay_frames_authorised_total', { outcome: 'unavailable' }).inc();
      deps.logger?.warn({ sid: room.sid, member: member.id }, 'relay.authorise_unavailable');
      sysError(connection, unavailable(1, ROOM_DETAILS.unavailable), ref);
      return;
    }
    if (live === null) {
      metrics.counter('relay_frames_authorised_total', { outcome: 'not_a_member' }).inc();
      deps.logger?.info({ sid: room.sid, member: member.id }, 'relay.member_gone');
      room.closeMember(member.id, CloseCode.Forbidden);
      return;
    }
    if (live.role !== member.role) room.setRole(member.id, live.role);
    const decision = authorizeFrame({ id: member.id, sid: room.sid, role: live.role }, frame, deps.mute);
    if (decision.ok) {
      metrics.counter('relay_frames_authorised_total', { outcome: 'allowed' }).inc();
      await next();
      return;
    }
    const kind = frame.k ?? 'none';
    if (decision.error === 'muted') {
      metrics.counter('relay_frames_authorised_total', { outcome: 'muted' }).inc();
      return;
    }
    metrics.counter('relay_frames_authorised_total', { outcome: 'forbidden' }).inc();
    deps.logger?.info(
      { sid: room.sid, member: member.id, kind, result: 'forbidden' },
      'relay.frame_forbidden',
    );
    sysError(connection, new AppError('forbidden', { detail: ROOM_DETAILS.forbidden }), ref);
    deps.audit?.emitDetached({
      workspaceId: live.workspaceId,
      actor: { type: 'user', id: live.userId },
      action: 'permission.denied',
      target: { type: 'session', id: room.sid },
      outcome: 'denied',
      meta: {
        attempted: kind,
        reason: SERVER_ONLY_KINDS.has(kind) ? 'server_only' : `role_${live.role}`,
        session_id: room.sid,
      },
    });
  };

  /** The rooms' members of `user` in sessions of workspace `wsp`. */
  function membersOf(user: string, wsp: string) {
    const found: { room: ReturnType<RoomRegistry['getOrCreate']>; memberId: string }[] = [];
    for (const room of registry.rooms()) {
      for (const m of room.members()) {
        if (m.userId === user && m.workspaceId === wsp) found.push({ room, memberId: m.id });
      }
    }
    return found;
  }

  async function onMembershipEvent(event: MembershipEvent): Promise<void> {
    membership.invalidateUser(event.user);
    const affected = membersOf(event.user, event.wsp);
    metrics.counter('relay_membership_events_total', { type: event.type }).inc();
    if (event.type === 'removed' || event.type === 'left') {
      for (const { room, memberId } of affected) room.closeMember(memberId, CloseCode.Forbidden);
      return;
    }
    // role_changed: re-read now, so the change holds from the very next frame.
    for (const { room, memberId } of affected) {
      try {
        const live = await membership.refresh(room.sid, memberId);
        if (live === null) room.closeMember(memberId, CloseCode.Forbidden);
        else room.setRole(memberId, live.role);
      } catch {
        // The next frame reads the records again (the cache entry is gone).
      }
    }
  }

  function listen(pubsub: Pick<PubSub, 'subscribe'>): { stop(): Promise<void> } {
    let unsubscribe: Unsubscribe | undefined;
    let timer: RoomTimer | undefined;
    let stopped = false;
    let attempt = 0;
    const subscribe = (): void => {
      pubsub
        .subscribe(MEMBERSHIP_EVENTS_CHANNEL, (message) => {
          const event = parseMembershipEvent(message);
          if (event === null) {
            metrics.counter('relay_membership_events_total', { type: 'invalid' }).inc();
            return;
          }
          void onMembershipEvent(event);
        })
        .then(
          (off) => {
            attempt = 0;
            if (stopped) void off();
            else unsubscribe = off;
          },
          () => {
            if (stopped) return;
            const wait = Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_BASE_MS * 2 ** attempt);
            attempt += 1;
            metrics.counter('relay_membership_subscribe_failures_total').inc();
            deps.logger?.warn({ retry_in_ms: wait }, 'relay.membership_subscribe_failed');
            timer = setTimer(subscribe, wait);
          },
        );
    };
    subscribe();
    return {
      async stop() {
        stopped = true;
        timer?.cancel();
        await unsubscribe?.();
      },
    };
  }

  return { onAdmitted, stage, onMembershipEvent, listen };
}
