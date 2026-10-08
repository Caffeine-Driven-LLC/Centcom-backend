/**
 * Notifications (B063): the Postgres side of the notification dispatcher, and the membership
 * lookups it resolves recipients with.
 *
 * - `insert` writes one row unless the user already has the event's row (a dispatch run again) or,
 *   for an event with a dedupe key, a row with that key in the last `windowMs`. The window slides,
 *   so the check and the insert run under a transaction-scoped advisory lock on (user, key): two
 *   such events at once make one row.
 * - `takeDigest` locks a user's pending digest items (`skip locked`, so concurrent runs never take
 *   the same ones), hands them to `send`, and marks them sent in the same transaction: when `send`
 *   throws, nothing is marked and the next run takes them again.
 * - Recipients are live: active users, members of a live workspace, session members who have not
 *   left.
 *
 * Owns: the SQL of notifications. Must not: store display text, or anything the caller did not
 * check against the category's allow-list.
 */
import type { WorkspaceRole } from '@centcom/core';
import { sql, type Kysely } from 'kysely';
import type { NotificationDb } from '../schema/notifications.js';
import { withTransaction } from '../tx.js';

/** A notification to write. */
export interface NewNotification {
  /** `ntf_` id. */
  id: string;
  userId: string;
  eventId: string;
  category: string;
  params: Record<string, string | number>;
  priority: 'low' | 'normal' | 'high';
  action: { type: string; deeplink?: string } | null;
  channels: string[];
  dedupeKey: string | null;
  /** Waits for the hourly e-mail digest. */
  digestPending: boolean;
  createdAt: Date;
}

/** A stored notification. */
export interface NotificationRecord extends NewNotification {
  readAt: Date | null;
  digestSentAt: Date | null;
}

/** What `insert` did: wrote the row, or found the event's row, or a row of the dedupe key. */
export type NotificationInsert = 'inserted' | 'duplicate_event' | 'deduped';

/** Notification persistence and the recipient lookups. */
export interface NotificationStore {
  insert(row: NewNotification, dedupeWindowMs: number): Promise<NotificationInsert>;
  /** The user's notifications, oldest first. */
  forUser(userId: string): Promise<NotificationRecord[]>;
  /** Users with items waiting for the digest. */
  usersWithPendingDigest(): Promise<string[]>;
  /**
   * Up to `max` of the user's pending digest items, oldest first, passed to `send` and then marked
   * sent at `now`, in one transaction; returns how many.
   */
  takeDigest(
    userId: string,
    max: number,
    now: Date,
    send: (items: NotificationRecord[]) => Promise<void>,
  ): Promise<number>;
  /** Active users with one of `roles` in the live workspace. */
  workspaceMembers(workspaceId: string, roles: readonly WorkspaceRole[]): Promise<string[]>;
  /** The active users behind the session members `memberIds` who have not left. */
  sessionMemberUsers(sessionId: string, memberIds: readonly string[]): Promise<string[]>;
  /** Those of `userIds` who are active members of the live workspace. */
  workspaceMembersAmong(workspaceId: string, userIds: readonly string[]): Promise<string[]>;
  /** Those of `userIds` who are active and in the session (not left). */
  sessionUsersAmong(sessionId: string, userIds: readonly string[]): Promise<string[]>;
  /** Those of `userIds` who are active. */
  activeUsers(userIds: readonly string[]): Promise<string[]>;
}

type Row = {
  id: string;
  user_id: string;
  event_id: string;
  category: string;
  params: Record<string, string | number>;
  priority: 'low' | 'normal' | 'high';
  action: { type: string; deeplink?: string } | null;
  channels: string[];
  dedupe_key: string | null;
  digest_pending: boolean;
  digest_sent_at: Date | null;
  created_at: Date;
  read_at: Date | null;
};

const record = (row: Row): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  eventId: row.event_id,
  category: row.category,
  params: row.params,
  priority: row.priority,
  action: row.action,
  channels: row.channels,
  dedupeKey: row.dedupe_key,
  digestPending: row.digest_pending,
  createdAt: row.created_at,
  readAt: row.read_at,
  digestSentAt: row.digest_sent_at,
});

const ids = (rows: { user_id: string }[]): string[] => [...new Set(rows.map((r) => r.user_id))];

/** The store on Postgres (table `notifications`, migration 20260102001400). */
export function createNotificationStore<DB extends NotificationDb>(
  database: Kysely<DB>,
): NotificationStore {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<NotificationDb>;

  return {
    insert(row, dedupeWindowMs) {
      return withTransaction(db, async (trx): Promise<NotificationInsert> => {
        if (row.dedupeKey !== null) {
          await sql`select pg_advisory_xact_lock(hashtextextended(${`${row.userId}:${row.dedupeKey}`}, 0))`.execute(
            trx,
          );
          const recent = await trx
            .selectFrom('notifications')
            .select('id')
            .where('user_id', '=', row.userId)
            .where('dedupe_key', '=', row.dedupeKey)
            .where('created_at', '>', new Date(row.createdAt.getTime() - dedupeWindowMs))
            .executeTakeFirst();
          if (recent !== undefined) return 'deduped';
        }
        const result = await trx
          .insertInto('notifications')
          .values({
            id: row.id,
            user_id: row.userId,
            event_id: row.eventId,
            category: row.category,
            params: JSON.stringify(row.params) as unknown as Record<string, string | number>,
            priority: row.priority,
            action: (row.action === null ? null : JSON.stringify(row.action)) as unknown as {
              type: string;
            } | null,
            channels: row.channels,
            dedupe_key: row.dedupeKey,
            digest_pending: row.digestPending,
            created_at: row.createdAt,
          })
          .onConflict((oc) => oc.constraint('notifications_user_id_event_id_key').doNothing())
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1 ? 'inserted' : 'duplicate_event';
      });
    },

    async forUser(userId) {
      const rows = await db
        .selectFrom('notifications')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(record);
    },

    async usersWithPendingDigest() {
      const rows = await db
        .selectFrom('notifications')
        .select('user_id')
        .distinct()
        .where('digest_pending', '=', true)
        .orderBy('user_id')
        .execute();
      return rows.map((r) => r.user_id);
    },

    takeDigest(userId, max, now, send) {
      return withTransaction(db, async (trx) => {
        const rows = await trx
          .selectFrom('notifications')
          .selectAll()
          .where('user_id', '=', userId)
          .where('digest_pending', '=', true)
          .orderBy('created_at')
          .orderBy('id')
          .limit(max)
          .forUpdate()
          .skipLocked()
          .execute();
        if (rows.length === 0) return 0;
        await send(rows.map(record));
        await trx
          .updateTable('notifications')
          .set({ digest_pending: false, digest_sent_at: now })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        return rows.length;
      });
    },

    async workspaceMembers(workspaceId, roles) {
      if (roles.length === 0) return [];
      const rows = await db
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('memberships.user_id')
        .where('memberships.workspace_id', '=', workspaceId)
        .where('memberships.role', 'in', [...roles])
        .where('workspaces.deleted_at', 'is', null)
        .where('users.status', '=', 'active')
        .orderBy('memberships.user_id')
        .execute();
      return ids(rows);
    },

    async sessionMemberUsers(sessionId, memberIds) {
      if (memberIds.length === 0) return [];
      const rows = await db
        .selectFrom('session_members')
        .innerJoin('users', 'users.id', 'session_members.user_id')
        .select('session_members.user_id')
        .where('session_members.session_id', '=', sessionId)
        .where('session_members.id', 'in', [...memberIds])
        .where('session_members.left_at', 'is', null)
        .where('users.status', '=', 'active')
        .orderBy('session_members.user_id')
        .execute();
      return ids(rows);
    },

    async workspaceMembersAmong(workspaceId, userIds) {
      if (userIds.length === 0) return [];
      const rows = await db
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('memberships.user_id')
        .where('memberships.workspace_id', '=', workspaceId)
        .where('memberships.user_id', 'in', [...userIds])
        .where('workspaces.deleted_at', 'is', null)
        .where('users.status', '=', 'active')
        .execute();
      return ids(rows);
    },

    async sessionUsersAmong(sessionId, userIds) {
      if (userIds.length === 0) return [];
      const rows = await db
        .selectFrom('session_members')
        .innerJoin('users', 'users.id', 'session_members.user_id')
        .select('session_members.user_id')
        .where('session_members.session_id', '=', sessionId)
        .where('session_members.user_id', 'in', [...userIds])
        .where('session_members.left_at', 'is', null)
        .where('users.status', '=', 'active')
        .execute();
      return ids(rows);
    },

    async activeUsers(userIds) {
      if (userIds.length === 0) return [];
      const rows = await db
        .selectFrom('users')
        .select('id as user_id')
        .where('id', 'in', [...userIds])
        .where('status', '=', 'active')
        .execute();
      return ids(rows);
    },
  };
}
