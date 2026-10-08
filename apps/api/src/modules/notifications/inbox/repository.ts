/**
 * The inbox's SQL (B065, CT-API-NOTIFY): a user's in-app notifications, which are the rows of B063's
 * `notifications` holding the `inbox` channel and created since a cut-off (the 90-day window; older
 * rows stay hidden until B090 purges them).
 *
 * - `list` pages newest first by `(created_at, id)` with B025's keyset pagination, on B063's
 *   `(user_id, created_at, id)` index, or on `notifications_inbox_unread_idx` for unread rows.
 * - `unreadCount` counts the unread rows on that partial index.
 * - `markRead` sets `read_at` once: a row already read keeps its first time.
 * - `markReadBatch` marks at most `max` of the oldest unread rows created by `now`, in one
 *   statement. Rows another transaction holds are skipped rather than waited for, so a batch never
 *   queues behind a lock.
 *
 * The inbox conditions are literals (`read_at is null`, `'inbox' = any (channels)`), never
 * parameters, so that they match the partial index's predicate.
 *
 * Owns: the inbox's statements. Must not: run a statement without the caller's user id in its
 * WHERE clause, or read a column the CT-NOTIF-PAYLOAD does not carry.
 */
import { paginate, type KeysetSpec, type Page, type PageParams } from '@centcom/core';
import type { NotificationDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** One inbox row: the columns CT-NOTIF-PAYLOAD is made of. */
export interface InboxRow {
  id: string;
  category: string;
  params: Record<string, string | number>;
  priority: 'low' | 'normal' | 'high';
  action: { type: string; deeplink?: string } | null;
  createdAt: Date;
  readAt: Date | null;
}

/** What `list` pages. */
export interface InboxListOptions {
  /** Unread rows only. */
  unread: boolean;
  /** Rows created before this are hidden (the retention window). */
  since: Date;
  page: PageParams;
}

/** The inbox's persistence. */
export interface InboxRepository {
  /** One page of the user's inbox, newest first. */
  list(userId: string, opts: InboxListOptions): Promise<Page<InboxRow>>;
  /** The user's unread inbox rows created since `since`. */
  unreadCount(userId: string, since: Date): Promise<number>;
  /**
   * Sets `read_at` to `now` on the user's inbox row `id` unless it is already read; returns the
   * row (with its first `read_at`), or null when the user has no such row since `since`.
   */
  markRead(userId: string, id: string, now: Date, since: Date): Promise<InboxRow | null>;
  /**
   * Marks up to `max` of the user's oldest unread inbox rows created between `since` and `now`
   * read at `now`, in one statement; returns how many it marked.
   */
  markReadBatch(userId: string, now: Date, since: Date, max: number): Promise<number>;
}

/** The list's one sort: newest first, ties broken by id. */
const LIST_SPEC: KeysetSpec = {
  sorts: { created: { column: 'created_at', direction: 'desc' } },
  idColumn: 'id',
};

const COLUMNS = [
  'id',
  'category',
  'params',
  'priority',
  'action',
  'created_at',
  'read_at',
] as const;

/** The inbox channel, as a literal (see the module comment). */
const IN_INBOX = sql<boolean>`'inbox' = any (channels)`;
const UNREAD = sql<boolean>`read_at is null`;

type Selected = {
  id: string;
  category: string;
  params: Record<string, string | number>;
  priority: 'low' | 'normal' | 'high';
  action: { type: string; deeplink?: string } | null;
  created_at: Date;
  read_at: Date | null;
};

const rowOf = (row: Selected): InboxRow => ({
  id: row.id,
  category: row.category,
  params: row.params,
  priority: row.priority,
  action: row.action,
  createdAt: row.created_at,
  readAt: row.read_at,
});

/** The inbox on Postgres (table `notifications`, migrations 20260102001400 and 20260102001800). */
export function createInboxRepository<DB extends NotificationDb>(
  database: Kysely<DB>,
): InboxRepository {
  // Kysely's types are invariant in the database type; only `notifications` is touched.
  const db = database as unknown as Kysely<NotificationDb>;

  const inbox = (userId: string, since: Date) =>
    db
      .selectFrom('notifications')
      .where('user_id', '=', userId)
      .where(IN_INBOX)
      .where('created_at', '>=', since);

  return {
    async list(userId, { unread, since, page }) {
      let query = inbox(userId, since).select(COLUMNS);
      if (unread) query = query.where(UNREAD);
      const result = await paginate(query, LIST_SPEC, page);
      return { ...result, data: result.data.map(rowOf) };
    },

    async unreadCount(userId, since) {
      const row = await inbox(userId, since)
        .where(UNREAD)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    },

    async markRead(userId, id, now, since) {
      const updated = await db
        .updateTable('notifications')
        .set({ read_at: now })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where(IN_INBOX)
        .where(UNREAD)
        .where('created_at', '>=', since)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (updated !== undefined) return rowOf(updated);
      // Already read (keep its first time), or not the user's: one more look tells which.
      const existing = await inbox(userId, since)
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return existing === undefined ? null : rowOf(existing);
    },

    async markReadBatch(userId, now, since, max) {
      const result = await sql`
        with batch as (
          select id from notifications
          where user_id = ${userId} and ${IN_INBOX} and ${UNREAD}
            and created_at >= ${since} and created_at <= ${now}
          order by created_at, id
          limit ${max}
          for update skip locked
        )
        update notifications as n set read_at = ${now}
        from batch
        where n.id = batch.id and n.user_id = ${userId} and n.read_at is null
      `.execute(db);
      return Number(result.numAffectedRows ?? 0n);
    },
  };
}
