/**
 * The sessions routes' store (B054): the reads and writes the routes need beyond B053's
 * `SessionService`, as a port (`SessionRouteStore`) and its Postgres implementation.
 *
 * - **standing:** the session as the routes decide on it (workspace, state, host, whether the host
 *   is connected, the policy's `locked`), the caller's live member row, whether the caller was
 *   removed (a row with `left_at` and none live: B051's kick), and the caller's role in the
 *   session's live workspace. Authorisation always reads these, never token claims.
 * - **Members:** `addMember` writes a member row with the slot B031 assigned, under the session's
 *   row lock, so one user never gets two live rows; `members` pages the live members by join
 *   order (rank by `joined_at`, then id, among every row the session ever had, so a member's
 *   number never moves), with exactly the device's registered public keys; members whose
 *   workspace role no longer allows a session are left out.
 *   `releaseMember` removes a row (and its B031 slot) this lane wrote a moment before, when the
 *   join or claim it was for did not go through, so no slot of the 50 is lost.
 * - **patchSession:** PATCH's compare-and-set in one transaction on one connection, with the
 *   session's row locked: the host check, the state, the caller's If-Match check, then the name
 *   (`sessions.name`, `updated_at`) and the policy (B051's `session_policy`, the five columns
 *   B053's `setPolicy` writes). B053's `rename` and `setPolicyDefaults` each commit on their own
 *   connection, so they cannot give one atomic If-Match write.
 * - **claimHost:** in one transaction with the session's row locked: refuses while the host is
 *   connected or the session is over; every live host row but the claimant's becomes `editor`
 *   (the relay's `control.transfer_host` swaps roles without moving `host_member_id`, so that
 *   column alone may name an old host), the claimant becomes `host`; then it writes
 *   `sessions.host_member_id`, `host_connected` (false), `last_host_seen_at` (now: the new host
 *   gets B053's 10 min grace to connect) and `updated_at`, queues the `control.host_changed` row
 *   and writes the audit event. B053's service has no host-change method.
 * - **Host outbox:** rows due are delivered with the session's current host and deleted once
 *   delivered (nothing reads them after); a failure is retried 5 s later, doubling, at most every
 *   10 min.
 *
 * Owns: the SQL. Must not: decide who may act (the routes and B021 do), or write the lifecycle's
 * state columns (`state`, `paused_at`, `expires_at`, `ended_at`, `end_reason`: B053's).
 */
import type { AuditDb } from '@centcom/core';
import type {
  SessionPolicyDefaults,
  SessionRow,
  StoredSession,
} from '../../modules/sessions/index.js';
import type { CreatedAt, createDb, SessionsLifecycleDatabase } from '@centcom/db';
import { sql, type ColumnType, type Generated, type Transaction } from 'kysely';

/** `session_host_outbox` (migration 20260102004400). */
export interface SessionHostOutboxTable {
  id: Generated<string>;
  session_id: ColumnType<string, string, never>;
  code: ColumnType<'failover', 'failover', never>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  created_at: CreatedAt;
}

/** What the routes read and write. */
export type SessionRoutesDatabase = SessionsLifecycleDatabase & {
  session_host_outbox: SessionHostOutboxTable;
};
/** A client over those tables. */
export type SessionRoutesDb = ReturnType<typeof createDb<SessionRoutesDatabase>>;
type Tx = Transaction<SessionRoutesDatabase>;

/** The first host-outbox retry waits this long; each later one twice as long, at most the max. */
export const HOST_OUTBOX_BASE_DELAY_MS = 5_000;
export const HOST_OUTBOX_MAX_DELAY_MS = 10 * 60 * 1000;

type SessionRole = 'host' | 'editor' | 'viewer';
type SessionState = 'pending' | 'live' | 'paused' | 'ended' | 'expired';

/** The session and the caller, as the routes decide on them. */
export interface Standing {
  session: {
    id: string;
    workspaceId: string | null;
    state: SessionState;
    hostMemberId: string | null;
    hostConnected: boolean;
    locked: boolean;
  };
  /** The caller's live member row (the newest when there were several). */
  member: { id: string; role: SessionRole; deviceId: string; slot: number } | null;
  /** The caller had a row that was removed (`left_at`) and has none live. */
  removed: boolean;
  /** The caller's role in the session's workspace, while it is not deleted. */
  workspaceRole: string | null;
}

/** A member as the members list shows it. */
export interface MemberView {
  id: string;
  userId: string;
  displayName: string;
  role: SessionRole;
  slot: number;
  /** 1-based rank by join time among every member the session ever had. */
  joinOrder: number;
  joinedAt: Date;
  /** The registered device of the row: public keys only. */
  device: { id: string; x25519: string; ed25519: string; fingerprint: string; revoked: boolean };
  /** The member's role in the session's workspace (caps the shown role), null outside one. */
  workspaceRole: string | null;
}

/** What `addMember` came to. */
export type AddMemberResult =
  | { kind: 'added' | 'existing'; member: { id: string; role: SessionRole; slot: number } }
  | { kind: 'over' }
  | { kind: 'gone' };

/** What `claimHost` came to. */
export type ClaimResult =
  | { kind: 'claimed'; previousHost: string | null }
  | { kind: 'already' }
  | { kind: 'host_present' }
  | { kind: 'over' }
  | { kind: 'not_member' }
  | { kind: 'gone' };

/** What `patchSession` came to. */
export type PatchResult =
  | { kind: 'patched'; session: StoredSession }
  | { kind: 'gone' }
  | { kind: 'not_host' }
  | { kind: 'over' };

/** A queued host change. */
export interface HostOutboxRow {
  id: string;
  sessionId: string;
  code: 'failover';
  attempts: number;
  /** The session's host now. */
  host: string | null;
}

/** The port. */
export interface SessionRouteStore {
  standing(sessionId: string, userId: string): Promise<Standing | null>;
  /** The device's owner and whether it was revoked; null when unknown. */
  device(deviceId: string): Promise<{ userId: string; revoked: boolean } | null>;
  /** Live members of the session. */
  countMembers(sessionId: string): Promise<number>;
  /** Adds the member with B031's `slot`; an existing live row of the user wins. */
  addMember(input: {
    sessionId: string;
    memberId: string;
    userId: string;
    deviceId: string;
    role: SessionRole;
    slot: number;
    at: Date;
  }): Promise<AddMemberResult>;
  /** Deletes member `memberId` (and its B031 slot), written moments ago for a join that failed. */
  releaseMember(sessionId: string, memberId: string): Promise<void>;
  /**
   * PATCH: with the row locked, checks the caller is the host and the session not over, calls
   * `check` with the session as it is (it throws to refuse: nothing is written), then writes,
   * with `audit` in the same transaction.
   */
  patchSession(
    sessionId: string,
    userId: string,
    change: { name?: string; policy?: Partial<SessionPolicyDefaults> },
    at: Date,
    check: (current: StoredSession) => void,
    audit: (trx: AuditDb) => Promise<void>,
  ): Promise<PatchResult>;
  /** One live member. */
  member(sessionId: string, memberId: string): Promise<MemberView | null>;
  /** Live members after `afterJoinOrder`, in join order; one more than `limit` says there are more. */
  members(sessionId: string, afterJoinOrder: number, limit: number): Promise<MemberView[]>;
  /** Makes `claimantId` the host (see the header); `audit` runs in the transaction. */
  claimHost(
    sessionId: string,
    claimantId: string,
    at: Date,
    audit: (trx: AuditDb) => Promise<void>,
  ): Promise<ClaimResult>;
  /** Host changes due at `now`, oldest first (of `sessionId` only, when given). */
  pendingHostChanges(now: Date, limit: number, sessionId?: string): Promise<HostOutboxRow[]>;
  /** Deletes a delivered row (`retryAt` null) or schedules its next attempt. */
  settleHostChange(id: string, retryAt: Date | null, attempts: number): Promise<void>;
}

/** The policy of a session without a `session_policy` row (B051's and B053's defaults). */
const DEFAULT_POLICY: Readonly<SessionPolicyDefaults> = Object.freeze({
  auto_approve: 'ask',
  share_history: false,
  queue_limit: 20,
  locked: false,
  auto_failover: false,
});

const OVER: readonly SessionState[] = ['ended', 'expired'];

/** The store over `db`. */
export function createSessionRouteStore(db: SessionRoutesDb): SessionRouteStore {
  const memberQuery = (q: SessionRoutesDb | Tx, sessionId: string) =>
    q
      .with('ranked', (w) =>
        w
          .selectFrom('session_members')
          .innerJoin('sessions', 'sessions.id', 'session_members.session_id')
          .select((eb) => [
            'session_members.id',
            'session_members.user_id',
            'session_members.device_id',
            'session_members.role',
            'session_members.slot',
            'session_members.joined_at',
            'session_members.left_at',
            'sessions.workspace_id',
            sql<string>`row_number() over (order by ${eb.ref('session_members.joined_at')}, ${eb.ref('session_members.id')})`.as(
              'join_order',
            ),
          ])
          .where('session_members.session_id', '=', sessionId),
      )
      .selectFrom('ranked')
      .innerJoin('users', 'users.id', 'ranked.user_id')
      .innerJoin('devices', 'devices.id', 'ranked.device_id')
      .leftJoin('memberships', (join) =>
        join
          .onRef('memberships.workspace_id', '=', 'ranked.workspace_id')
          .onRef('memberships.user_id', '=', 'ranked.user_id'),
      )
      .select([
        'ranked.id',
        'ranked.user_id',
        'ranked.role',
        'ranked.slot',
        'ranked.joined_at',
        'ranked.join_order',
        'users.display_name',
        'devices.id as device_id',
        'devices.x25519_pub',
        'devices.ed25519_pub',
        'devices.fingerprint',
        'devices.revoked_at',
        'memberships.role as workspace_role',
      ])
      .where('ranked.left_at', 'is', null)
      // A member whose workspace role no longer allows a session (removed, or billing) is not
      // shown: the relay's live membership refuses them too.
      .where((eb) =>
        eb.or([
          eb('ranked.workspace_id', 'is', null),
          eb.and([eb('memberships.role', 'is not', null), eb('memberships.role', '!=', 'billing')]),
        ]),
      );

  type MemberRow = Awaited<ReturnType<ReturnType<typeof memberQuery>['execute']>>[number];
  const view = (r: MemberRow): MemberView => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    role: r.role,
    slot: r.slot,
    joinOrder: Number(r.join_order),
    joinedAt: r.joined_at,
    device: {
      id: r.device_id,
      x25519: r.x25519_pub,
      ed25519: r.ed25519_pub,
      fingerprint: r.fingerprint,
      revoked: r.revoked_at !== null,
    },
    workspaceRole: r.workspace_role ?? null,
  });

  /** The session as B053 stores it (its row and policy), the row locked when `lock`. */
  const selectStored = async (
    trx: Tx,
    sessionId: string,
    lock: boolean,
  ): Promise<StoredSession | null> => {
    if (lock) {
      const locked = await trx
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined) return null;
    }
    const r = await trx
      .selectFrom('sessions')
      .leftJoin('session_policy', 'session_policy.session_id', 'sessions.id')
      .select([
        'sessions.id',
        'sessions.workspace_id',
        'sessions.name',
        'sessions.state',
        'sessions.region',
        'sessions.created_by',
        'sessions.created_at',
        'sessions.ended_at',
        'sessions.host_member_id',
        'sessions.host_connected',
        'sessions.last_host_seen_at',
        'sessions.paused_at',
        'sessions.expires_at',
        'sessions.end_reason',
        'session_policy.auto_approve',
        'session_policy.share_history',
        'session_policy.queue_limit',
        'session_policy.locked',
        'session_policy.auto_failover',
      ])
      .where('sessions.id', '=', sessionId)
      .executeTakeFirst();
    if (r === undefined) return null;
    const { auto_approve, share_history, queue_limit, locked, auto_failover, ...row } = r;
    return {
      row: row as SessionRow,
      policy:
        auto_approve === null
          ? null
          : {
              auto_approve,
              share_history: share_history ?? false,
              queue_limit: queue_limit ?? 20,
              locked: locked ?? false,
              auto_failover: auto_failover ?? false,
            },
    };
  };

  return {
    async standing(sessionId, userId) {
      const s = await db
        .selectFrom('sessions')
        .leftJoin('session_policy', 'session_policy.session_id', 'sessions.id')
        .leftJoin('workspaces', 'workspaces.id', 'sessions.workspace_id')
        .leftJoin('memberships', (join) =>
          join
            .onRef('memberships.workspace_id', '=', 'sessions.workspace_id')
            .on('memberships.user_id', '=', userId),
        )
        .select([
          'sessions.id',
          'sessions.workspace_id',
          'sessions.state',
          'sessions.host_member_id',
          'sessions.host_connected',
          'session_policy.locked',
          'workspaces.deleted_at',
          'memberships.role as workspace_role',
        ])
        .where('sessions.id', '=', sessionId)
        .executeTakeFirst();
      if (s === undefined) return null;
      const rows = await db
        .selectFrom('session_members')
        .select(['id', 'role', 'device_id', 'slot', 'left_at'])
        .where('session_id', '=', sessionId)
        .where('user_id', '=', userId)
        .orderBy('joined_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const live = rows.find((r) => r.left_at === null);
      return {
        session: {
          id: s.id,
          workspaceId: s.workspace_id,
          state: s.state,
          hostMemberId: s.host_member_id,
          hostConnected: s.host_connected,
          locked: s.locked === true,
        },
        member:
          live === undefined
            ? null
            : { id: live.id, role: live.role, deviceId: live.device_id, slot: live.slot },
        removed: live === undefined && rows.length > 0,
        workspaceRole: s.deleted_at === null ? (s.workspace_role ?? null) : null,
      };
    },

    async device(deviceId) {
      const r = await db
        .selectFrom('devices')
        .select(['user_id', 'revoked_at'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      return r === undefined ? null : { userId: r.user_id, revoked: r.revoked_at !== null };
    },

    async countMembers(sessionId) {
      const r = await db
        .selectFrom('session_members')
        .select(db.fn.countAll<string>().as('n'))
        .where('session_id', '=', sessionId)
        .where('left_at', 'is', null)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },

    addMember(input) {
      return db.transaction().execute(async (trx): Promise<AddMemberResult> => {
        const s = await trx
          .selectFrom('sessions')
          .select('state')
          .where('id', '=', input.sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (s === undefined) return { kind: 'gone' };
        if (OVER.includes(s.state)) return { kind: 'over' };
        const existing = await trx
          .selectFrom('session_members')
          .select(['id', 'role', 'slot'])
          .where('session_id', '=', input.sessionId)
          .where('user_id', '=', input.userId)
          .where('left_at', 'is', null)
          .orderBy('joined_at', 'desc')
          .executeTakeFirst();
        if (existing !== undefined) return { kind: 'existing', member: existing };
        await trx
          .insertInto('session_members')
          .values({
            id: input.memberId,
            session_id: input.sessionId,
            user_id: input.userId,
            device_id: input.deviceId,
            role: input.role,
            slot: input.slot,
            joined_at: input.at,
          })
          .execute();
        return {
          kind: 'added',
          member: { id: input.memberId, role: input.role, slot: input.slot },
        };
      });
    },

    releaseMember(sessionId, memberId) {
      return db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('session_members')
          .where('id', '=', memberId)
          .where('session_id', '=', sessionId)
          .execute();
        await trx
          .deleteFrom('session_member_slots')
          .where('session_id', '=', sessionId)
          .where('member_id', '=', memberId)
          .execute();
      });
    },

    patchSession(sessionId, userId, change, at, check, audit) {
      return db.transaction().execute(async (trx): Promise<PatchResult> => {
        const current = await selectStored(trx, sessionId, true);
        if (current === null) return { kind: 'gone' };
        const host = await trx
          .selectFrom('session_members')
          .select('id')
          .where('session_id', '=', sessionId)
          .where('user_id', '=', userId)
          .where('left_at', 'is', null)
          .where('id', '=', current.row.host_member_id ?? '')
          .executeTakeFirst();
        if (host === undefined) return { kind: 'not_host' };
        if (OVER.includes(current.row.state)) return { kind: 'over' };
        check(current);
        if (change.name !== undefined) {
          await trx
            .updateTable('sessions')
            .set({ name: change.name, updated_at: at })
            .where('id', '=', sessionId)
            .execute();
        }
        if (change.policy !== undefined) {
          const p = { ...(current.policy ?? DEFAULT_POLICY), ...change.policy };
          const values = {
            auto_approve: p.auto_approve,
            share_history: p.share_history,
            queue_limit: p.queue_limit,
            locked: p.locked,
            auto_failover: p.auto_failover,
          };
          await trx
            .insertInto('session_policy')
            .values({ session_id: sessionId, ...values })
            .onConflict((oc) => oc.column('session_id').doUpdateSet({ ...values, updated_at: at }))
            .execute();
        }
        await audit(trx);
        const patched = await selectStored(trx, sessionId, false);
        if (patched === null) throw new Error('sessions: the patched session is gone');
        return { kind: 'patched', session: patched };
      });
    },

    async member(sessionId, memberId) {
      const r = await memberQuery(db, sessionId)
        .where('ranked.id', '=', memberId)
        .executeTakeFirst();
      return r === undefined ? null : view(r);
    },

    async members(sessionId, afterJoinOrder, limit) {
      const rows = await memberQuery(db, sessionId)
        .where('ranked.join_order', '>', String(afterJoinOrder))
        .orderBy('ranked.join_order')
        .limit(limit + 1)
        .execute();
      return rows.map(view);
    },

    claimHost(sessionId, claimantId, at, audit) {
      return db
        .transaction()
        .execute(async (trx): Promise<ClaimResult> => {
          const s = await trx
            .selectFrom('sessions')
            .select(['state', 'host_member_id', 'host_connected'])
            .where('id', '=', sessionId)
            .forUpdate()
            .executeTakeFirst();
          if (s === undefined) return { kind: 'gone' };
          if (OVER.includes(s.state)) return { kind: 'over' };
          const hosts = await trx
            .selectFrom('session_members')
            .select('id')
            .where('session_id', '=', sessionId)
            .where('role', '=', 'host')
            .where('left_at', 'is', null)
            .execute();
          if (
            s.host_member_id === claimantId &&
            hosts.length === 1 &&
            hosts[0]?.id === claimantId
          ) {
            return { kind: 'already' };
          }
          if (s.host_connected) return { kind: 'host_present' };
          const previous = s.host_member_id;
          // Every live host but the claimant: a relay-side transfer moves the role, not the column.
          await trx
            .updateTable('session_members')
            .set({ role: 'editor' })
            .where('session_id', '=', sessionId)
            .where('role', '=', 'host')
            .where('left_at', 'is', null)
            .where('id', '!=', claimantId)
            .execute();
          const promoted = await trx
            .updateTable('session_members')
            .set({ role: 'host' })
            .where('id', '=', claimantId)
            .where('session_id', '=', sessionId)
            .where('left_at', 'is', null)
            .executeTakeFirst();
          if (Number(promoted.numUpdatedRows) !== 1) {
            // Rolls the demotion back with the rest.
            throw new ClaimRollback();
          }
          await trx
            .updateTable('sessions')
            .set({
              host_member_id: claimantId,
              host_connected: false,
              last_host_seen_at: at,
              updated_at: at,
            })
            .where('id', '=', sessionId)
            .execute();
          await trx
            .insertInto('session_host_outbox')
            .values({ session_id: sessionId, code: 'failover', next_attempt_at: at })
            .execute();
          await audit(trx);
          return { kind: 'claimed', previousHost: previous };
        })
        .catch((err: unknown) => {
          if (err instanceof ClaimRollback) return { kind: 'not_member' } as const;
          throw err;
        });
    },

    async pendingHostChanges(now, limit, sessionId) {
      let q = db
        .selectFrom('session_host_outbox')
        .innerJoin('sessions', 'sessions.id', 'session_host_outbox.session_id')
        .select([
          'session_host_outbox.id',
          'session_host_outbox.session_id',
          'session_host_outbox.code',
          'session_host_outbox.attempts',
          'sessions.host_member_id',
        ])
        .where('session_host_outbox.next_attempt_at', '<=', now)
        .orderBy('session_host_outbox.id')
        .limit(limit);
      if (sessionId !== undefined) q = q.where('session_host_outbox.session_id', '=', sessionId);
      const rows = await q.execute();
      return rows.map((r) => ({
        id: String(r.id),
        sessionId: r.session_id,
        code: r.code,
        attempts: r.attempts,
        host: r.host_member_id,
      }));
    },

    async settleHostChange(id, retryAt, attempts) {
      if (retryAt === null) {
        await db.deleteFrom('session_host_outbox').where('id', '=', id).execute();
        return;
      }
      await db
        .updateTable('session_host_outbox')
        .set({ attempts, next_attempt_at: retryAt })
        .where('id', '=', id)
        .execute();
    },
  };
}

/** Thrown inside claimHost's transaction to roll it back. */
class ClaimRollback extends Error {}
