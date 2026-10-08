/**
 * The in-app inbox (B065, CT-API-NOTIFY): a user's notifications as CT-NOTIF-PAYLOAD, newest first,
 * with an unread filter and count, marking one read, and marking all read.
 *
 * - Only the last 90 days show (INBOX_RETENTION_MS), even before B090 purges older rows.
 * - Cursors are B025's: signed, expiring after 24 h, and bound to the user and the unread filter,
 *   so another user's cursor or one from the other filter is a 400 `cursor_invalid`.
 * - Items carry the CT-NOTIF-PAYLOAD fields only, and `params` is cut to the category's
 *   allow-list (B063 `PARAM_RULES`) again on the way out.
 * - Marking read is idempotent: a second mark keeps the first `read_at`. A malformed id is a 404,
 *   like an unknown or another user's one, so ids cannot be probed.
 * - Read-all marks the unread rows that exist when it starts, in statements of at most 500 rows,
 *   and answers only once every batch is done.
 * - A database timeout or lost connection is a 503 with `retry_after_s`. A read-all that fails
 *   part-way answers 503 too, never a partial count.
 *
 * Owns: the inbox's rules. Must not: take the user id from anywhere but the caller's token, or
 * return a field CT-NOTIF-PAYLOAD does not define.
 */
import { isId } from '@centcom/contracts';
import {
  booleanFilter,
  defineFilters,
  idFilter,
  notFound,
  unavailable,
  type NotificationCategory,
  type Page,
  type SigningKeys,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import { PARAM_RULES } from '../dispatcher/params.js';
import type { NotificationPayload } from '../dispatcher/ports.js';
import type { InboxRepository, InboxRow } from './repository.js';

/** How far back the inbox reaches (CT-NOTIF-PAYLOAD retention: 90 days). */
export const INBOX_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows one read-all statement marks at most. */
export const READ_ALL_BATCH_SIZE = 500;

/** The list's sort name (B025 `parsePageQuery`): newest first. */
export const INBOX_SORT = 'created';

/** The details of the inbox's refusals (GUIDELINES §3.4). */
export const INBOX_DETAILS = Object.freeze({
  notFound: 'There is no such notification.',
  unavailable: 'The inbox is busy. Try again shortly.',
} as const);

/** A cursor is bound to the user it pages and to the unread filter. */
const CURSOR_FILTERS = defineFilters({ user: idFilter('usr'), unread: booleanFilter() });

/** One list request. */
export interface InboxListQuery {
  /** Unread notifications only. */
  unread: boolean;
  /** 1..200 (B025 `parsePageQuery` checks it). */
  limit: number;
  cursor?: string;
}

/** One page of the inbox and the user's unread count. */
export interface InboxPage {
  page: Page<NotificationPayload>;
  unreadCount: number;
}

/** What the inbox needs. */
export interface InboxServiceDeps {
  repository: InboxRepository;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** A row as CT-NOTIF-PAYLOAD: its fields only, `params` cut to the category's allow-list. */
export function inboxPayload(row: InboxRow): NotificationPayload {
  const allowed =
    (PARAM_RULES as Record<string, Readonly<Record<string, unknown>> | undefined>)[row.category] ??
    {};
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row.params)) {
    if (Object.hasOwn(allowed, key)) params[key] = value;
  }
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    read_at: row.readAt === null ? null : row.readAt.toISOString(),
    category: row.category as NotificationCategory,
    title_key: `notif.${row.category}.title`,
    body_key: `notif.${row.category}.body`,
    params,
    ...(row.action === null
      ? {}
      : {
          action: {
            type: row.action.type,
            ...(row.action.deeplink === undefined ? {} : { deeplink: row.action.deeplink }),
          } as NonNullable<NotificationPayload['action']>,
        }),
    priority: row.priority,
  };
}

/** A database failure that is the database's fault (timeout, lost connection): a 503. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(1, INBOX_DETAILS.unavailable, { cause: new Error('database unavailable') });
  }
  throw err;
}

const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    return databaseFailure(err);
  }
};

/** The inbox. */
export class InboxService {
  readonly #clock: () => number;

  constructor(private readonly deps: InboxServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  /** One page of the user's inbox, newest first, and their unread count. */
  async list(
    userId: string,
    q: InboxListQuery,
    now: Date = new Date(this.#clock()),
  ): Promise<InboxPage> {
    const since = new Date(now.getTime() - INBOX_RETENTION_MS);
    const [page, unreadCount] = await guarded(() =>
      Promise.all([
        this.deps.repository.list(userId, {
          unread: q.unread,
          since,
          page: {
            limit: q.limit,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            sort: INBOX_SORT,
            filterHash: CURSOR_FILTERS.hash({ user: userId, unread: q.unread }),
            keys: this.deps.cursorKeys,
            now: now.getTime(),
          },
        }),
        this.deps.repository.unreadCount(userId, since),
      ]),
    );
    return { page: { ...page, data: page.data.map(inboxPayload) }, unreadCount };
  }

  /** Marks the user's notification `id` read (once); 404 for anything that is not theirs. */
  async markRead(userId: string, id: string, now: Date): Promise<NotificationPayload> {
    if (!isId('ntf', id)) throw notFound(INBOX_DETAILS.notFound);
    const since = new Date(now.getTime() - INBOX_RETENTION_MS);
    const row = await guarded(() => this.deps.repository.markRead(userId, id, now, since));
    if (row === null) throw notFound(INBOX_DETAILS.notFound);
    return inboxPayload(row);
  }

  /** Marks every unread notification of the user's read, 500 at a time; returns how many. */
  async markAllRead(userId: string, now: Date): Promise<{ updated: number }> {
    const since = new Date(now.getTime() - INBOX_RETENTION_MS);
    let updated = 0;
    for (;;) {
      const marked = await guarded(() =>
        this.deps.repository.markReadBatch(userId, now, since, READ_ALL_BATCH_SIZE),
      );
      updated += marked;
      if (marked < READ_ALL_BATCH_SIZE) return { updated };
    }
  }
}
