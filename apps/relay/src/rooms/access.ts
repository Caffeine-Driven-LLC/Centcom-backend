/**
 * The Postgres implementation of B038's `SessionAccess` (B043): what the live records say about a
 * ticket's session, member and device when a client says hello.
 *
 * - **Session:** `sessions.state`; an unknown session is null (4404).
 * - **Member:** the live membership (`LiveMembership.refresh`, which also warms the 2 s cache the
 *   authorise stage reads): the role from the records, never the ticket's (CT-RBAC rule 3); null
 *   when the member left, was removed from the workspace, or holds a role that allows no session.
 *   The name is the user's display name; the slot is B031's, assigned at the member's first
 *   admitted hello (never for a refused one).
 * - **Device:** revoked when it is unknown, revoked, or another user's.
 * - **Plan:** `relay_access` and `max_session_members` of the workspace's effective plan, by the
 *   same rules as B069's resolver (CT-ENTITLEMENTS §4): the subscription's plan while `active` or
 *   `trialing`, while `past_due` until `grace_until`, while `canceled` until `period_end`; the
 *   free plan otherwise or without a subscription. A null `max_session_members` (unlimited) is
 *   the hard cap of 50.
 * - **Room cap:** a member not yet in this node's room is refused with `session_full` (403, close
 *   4403) when the room already holds that many distinct members; a member's second device is not
 *   counted again. The check runs before the slot is assigned, so a refused member gets none.
 *   (B031 refuses a 51st slot holder the same way.)
 *
 * Owns: these reads. Must not: answer from ticket claims, or assign a slot to a member it refuses.
 */
import { AppError } from '@centcom/core';
import type { CoreDatabase, createDb, EntitlementsDatabase } from '@centcom/db';
import type { SessionAccess, SessionAccessResult } from '../handshake/access.js';
import { MAX_SESSION_MEMBERS, type SlotService } from '../slots/index.js';
import type { LiveMembership } from './membership.js';
import type { RoomRegistry } from './registry.js';

/** The tables these reads use. */
export type AccessDb = CoreDatabase & EntitlementsDatabase;
/** A database client over them (Kysely, through @centcom/db). */
export type AccessDbClient = ReturnType<typeof createDb<AccessDb>>;

/** What the relay needs of a workspace's plan. */
export interface SessionEntitlements {
  relayAccess: boolean;
  /** Distinct members per session; never more than 50. */
  maxSessionMembers: number;
}

/** A subscription's state, as `workspace_entitlements` holds it. */
export interface SubscriptionState {
  plan_id: string;
  status: string;
  grace_until: Date | null;
  period_end: Date | null;
}

/** The plan whose limits apply at `now` (B069's rules, CT-ENTITLEMENTS §4). */
export function effectivePlan(state: SubscriptionState | undefined, now: Date): string {
  if (state === undefined) return 'free';
  const at = now.getTime();
  const keeps =
    state.status === 'active' ||
    state.status === 'trialing' ||
    (state.status === 'past_due' && state.grace_until !== null && at <= state.grace_until.getTime()) ||
    (state.status === 'canceled' && state.period_end !== null && at <= state.period_end.getTime());
  return keeps ? state.plan_id : 'free';
}

/** `relay_access` and `max_session_members` of `workspaceId` at `now` (no workspace: the free plan). */
export async function loadSessionEntitlements(
  db: AccessDbClient,
  workspaceId: string | null,
  now: Date,
): Promise<SessionEntitlements> {
  const state =
    workspaceId === null
      ? undefined
      : await db
          .selectFrom('workspace_entitlements')
          .select(['plan_id', 'status', 'grace_until', 'period_end'])
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst();
  const plan = effectivePlan(state, now);
  const limits = await db
    .selectFrom('plan_limits')
    .select(['key', 'bool_value', 'int_value'])
    .where('plan_id', '=', plan as 'free')
    .where('key', 'in', ['relay_access', 'max_session_members'])
    .execute();
  const relay = limits.find((l) => l.key === 'relay_access');
  const members = limits.find((l) => l.key === 'max_session_members');
  const max = members?.int_value ?? null;
  return {
    relayAccess: relay?.bool_value === true,
    maxSessionMembers: max === null ? MAX_SESSION_MEMBERS : Math.min(max, MAX_SESSION_MEMBERS),
  };
}

/** True when member `mid` may join `room` under a cap of `max` distinct members. */
export const roomHasSpace = (
  room: Pick<NonNullable<ReturnType<RoomRegistry['get']>>, 'hasMember' | 'memberCount'>,
  mid: string,
  max: number,
): boolean => room.hasMember(mid) || room.memberCount() < Math.min(max, MAX_SESSION_MEMBERS);

/** The session holds as many members as its plan allows: `session_full`, close 4403. */
export const sessionFull = (): AppError =>
  new AppError('session_full', {
    detail: 'The session already has as many members as its plan allows.',
  });

/** What the access needs. */
export interface PostgresSessionAccessDeps {
  db: AccessDbClient;
  membership: LiveMembership;
  slots: Pick<SlotService, 'assign' | 'get'>;
  /** This node's rooms, for the member cap. */
  rooms: Pick<RoomRegistry, 'get'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** B038's `SessionAccess` over Postgres. */
export function createPostgresSessionAccess(deps: PostgresSessionAccessDeps): SessionAccess {
  const clock = deps.clock ?? Date.now;
  return {
    async resolve(sid, mid, dev) {
      const session = await deps.db
        .selectFrom('sessions')
        .select(['state', 'workspace_id'])
        .where('id', '=', sid)
        .executeTakeFirst();
      if (session === undefined) return null;
      const [entitlements, live, device] = await Promise.all([
        loadSessionEntitlements(deps.db, session.workspace_id, new Date(clock())),
        deps.membership.refresh(sid, mid),
        deps.db
          .selectFrom('devices')
          .select(['user_id', 'revoked_at'])
          .where('id', '=', dev)
          .executeTakeFirst(),
      ]);
      const result: SessionAccessResult = {
        session: { state: session.state, maxMembers: entitlements.maxSessionMembers },
        member: null,
        deviceRevoked:
          device === undefined || device.revoked_at !== null || device.user_id !== live?.userId,
        relayAccess: entitlements.relayAccess,
      };
      if (live === null) return result;
      const user = await deps.db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', live.userId)
        .executeTakeFirst();
      const admissible =
        !result.deviceRevoked &&
        result.relayAccess &&
        session.state !== 'ended' &&
        session.state !== 'expired';
      if (admissible) {
        const room = deps.rooms.get(sid);
        if (room !== undefined && !roomHasSpace(room, mid, entitlements.maxSessionMembers)) {
          throw sessionFull();
        }
      }
      const slot = admissible
        ? await deps.slots.assign(sid, mid)
        : ((await deps.slots.get(sid, mid)) ?? 0);
      return {
        ...result,
        member: { id: mid, name: user?.display_name ?? 'Member', slot, role: live.role },
      };
    },
  };
}
