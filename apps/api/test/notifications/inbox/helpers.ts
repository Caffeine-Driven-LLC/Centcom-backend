/**
 * Fixtures for the inbox tests (B065): an in-memory repository with the Postgres one's rules (the
 * user's own rows holding `inbox`, inside the window, newest first by B025's in-memory keyset;
 * read-all oldest first, by `now`, at most `max` a batch), the routes on the real auth plugin
 * (B017), and Postgres seeding for the tests that run on a migrated database (DATABASE_URL, CI's
 * integration job).
 */
import { randomBytes } from 'node:crypto';
import { paginateArray, Secret, type SigningKeys } from '@centcom/core';
import type { CoreDatabase, NotificationDb } from '@centcom/db';
import { fastify } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type {
  InboxRepository,
  InboxRow,
} from '../../../src/modules/notifications/inbox/repository.js';
import { InboxService } from '../../../src/modules/notifications/inbox/service.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { notificationRoutes } from '../../../src/routes/notifications/index.js';
import { captureLogger } from '../../helpers.js';
import {
  memoryTokens,
  newId,
  T0,
  testClock,
  type TestClock,
} from '../../modules/auth/tokens/helpers.js';

export { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
export { newId, T0 };

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** Cursor signing keys for the tests. */
export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];

/** A stored notification as the in-memory repository holds it. */
export interface MemoryRow extends InboxRow {
  userId: string;
  channels: string[];
}

/** An `approval_needed` notification of `userId`, created at `createdAt`. */
export function inboxRow(
  userId: string,
  createdAt: number,
  overrides: Partial<MemoryRow> = {},
): MemoryRow {
  const session = newId('ses');
  return {
    id: newId('ntf'),
    userId,
    category: 'approval_needed',
    params: { agent: newId('agt'), session, risk: 'high' },
    priority: 'high',
    action: { type: 'open_session', deeplink: `centcom://s/${session}` },
    channels: ['inbox', 'push'],
    createdAt: new Date(createdAt),
    readAt: null,
    ...overrides,
  };
}

/**
 * `count` notifications of `userId`, one a minute back from `newest`; every `unreadEvery`-th one
 * (from the newest) unread, the rest read an hour after they were created.
 */
export function inboxRows(
  userId: string,
  count: number,
  opts: { newest?: number; unreadEvery?: number } = {},
): MemoryRow[] {
  const newest = opts.newest ?? T0 - MINUTE_MS;
  const every = opts.unreadEvery ?? 4;
  return Array.from({ length: count }, (_, i) => {
    const createdAt = newest - i * MINUTE_MS;
    return inboxRow(userId, createdAt, {
      readAt: i % every === 0 ? null : new Date(createdAt + 60 * MINUTE_MS),
    });
  });
}

const strip = (row: MemoryRow): InboxRow => ({
  id: row.id,
  category: row.category,
  params: row.params,
  priority: row.priority,
  action: row.action,
  createdAt: row.createdAt,
  readAt: row.readAt,
});

/** What a memory repository call may fail with, by operation and call number (from 1). */
export type FailOn = (op: keyof InboxRepository, call: number) => Error | undefined;

/** The repository in memory, by the Postgres one's rules. */
export function memoryInbox(rows: MemoryRow[], failOn: FailOn = () => undefined) {
  const calls = { list: 0, unreadCount: 0, markRead: 0, markReadBatch: 0 };
  const batches: number[] = [];
  const check = (op: keyof InboxRepository): void => {
    calls[op] += 1;
    const error = failOn(op, calls[op]);
    if (error !== undefined) throw error;
  };
  const visible = (userId: string, since: Date) =>
    rows.filter((r) => r.userId === userId && r.channels.includes('inbox') && r.createdAt >= since);
  const repository: InboxRepository = {
    list: (userId, { unread, since, page }) =>
      Promise.resolve().then(() => {
        check('list');
        const items = visible(userId, since).filter((r) => !unread || r.readAt === null);
        const result = paginateArray(
          items,
          {
            sorts: { created: { value: (r) => r.createdAt.getTime(), direction: 'desc' } },
            id: (r) => r.id,
          },
          page,
        );
        return { ...result, data: result.data.map(strip) };
      }),
    unreadCount: (userId, since) =>
      Promise.resolve().then(() => {
        check('unreadCount');
        return visible(userId, since).filter((r) => r.readAt === null).length;
      }),
    markRead: (userId, id, now, since) =>
      Promise.resolve().then(() => {
        check('markRead');
        const row = visible(userId, since).find((r) => r.id === id);
        if (row === undefined) return null;
        row.readAt ??= now;
        return strip(row);
      }),
    markReadBatch: (userId, now, since, max) =>
      Promise.resolve().then(() => {
        check('markReadBatch');
        const batch = visible(userId, since)
          .filter((r) => r.readAt === null && r.createdAt <= now)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
          .slice(0, max);
        for (const row of batch) row.readAt = now;
        batches.push(batch.length);
        return batch.length;
      }),
  };
  return { repository, rows, calls, batches };
}

/** The inbox routes over `repository`, on the real auth plugin, with a clock the test moves. */
export async function inboxApp(
  repository: InboxRepository = memoryInbox([]).repository,
  clock: TestClock = testClock(),
) {
  const { tokens } = memoryTokens({ clock });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['profile'],
    }),
  );
  const captured = captureLogger();
  const inbox = new InboxService({ repository, cursorKeys: KEYS, clock: clock.now });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(notificationRoutes, { inbox, clock: clock.now });
  await app.ready();
  const bearerFor = async (userId: string, scopes = ['profile']) => {
    const { access_token: token } = await tokens.issueTokens({ userId, deviceId: null, scopes });
    return { authorization: `Bearer ${token}` };
  };
  return { app, clock, captured, bearerFor };
}

/** A CT-PAGE body of the inbox. */
export interface InboxBody {
  data: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Every page of `GET /v1/notifications` with `query`, following `next_cursor`. */
export async function allPages(
  app: Awaited<ReturnType<typeof inboxApp>>['app'],
  headers: Record<string, string>,
  query = '',
): Promise<{ pages: InboxBody[]; unreadCounts: string[] }> {
  const pages: InboxBody[] = [];
  const unreadCounts: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query);
    if (cursor !== null) params.set('cursor', cursor);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/notifications?${params.toString()}`,
      headers,
    });
    if (response.statusCode !== 200) throw new Error(`${response.statusCode} ${response.body}`);
    const body = response.json<InboxBody>();
    pages.push(body);
    unreadCounts.push(String(response.headers['x-unread-count']));
    cursor = body.next_cursor;
  } while (cursor !== null && pages.length < 100);
  return { pages, unreadCounts };
}

/** Inserts an active user; returns the id. */
export async function pgUser(db: Kysely<CoreDatabase>): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Inbox Tester' })
    .execute();
  return id;
}

/** Writes `rows` into `notifications` (in chunks). */
export async function pgInsert(db: Kysely<CoreDatabase>, rows: MemoryRow[]): Promise<void> {
  const ndb = db as unknown as Kysely<NotificationDb>;
  for (let i = 0; i < rows.length; i += 500) {
    await ndb
      .insertInto('notifications')
      .values(
        rows.slice(i, i + 500).map((r) => ({
          id: r.id,
          user_id: r.userId,
          event_id: `evt-${r.id.slice(4)}`,
          category: r.category,
          params: JSON.stringify(r.params) as never,
          priority: r.priority,
          action: (r.action === null ? null : JSON.stringify(r.action)) as never,
          channels: r.channels,
          dedupe_key: null,
          digest_pending: false,
          created_at: r.createdAt,
        })),
      )
      .execute();
  }
  // read_at is not written at insert (B063's table types); set it afterwards, in one statement.
  const read = rows.filter((r) => r.readAt !== null);
  if (read.length === 0) return;
  await sql`
    update notifications as n set read_at = v.t
    from unnest(${read.map((r) => r.id)}::text[], ${read.map((r) => r.readAt?.toISOString())}::timestamptz[])
      as v(id, t)
    where n.id = v.id
  `.execute(db);
}

/**
 * `count` notifications of `userId` straight from SQL (ids `ntf_` plus 26 digits), one a minute
 * back from `newest`; `unread` of them, the newest-first every `count / unread`-th, unread.
 */
export async function pgBulk(
  db: Kysely<CoreDatabase>,
  userId: string,
  count: number,
  opts: { newest: Date; unreadEvery: number; prefix?: string },
): Promise<void> {
  const prefix = opts.prefix ?? '1';
  await sql`
    insert into notifications
      (id, user_id, event_id, category, params, priority, action, channels, created_at, read_at)
    select
      'ntf_' || ${prefix}::text || lpad(g::text, 25, '0'),
      ${userId},
      'bulk-' || ${prefix}::text || '-' || g,
      'agent_done',
      '{"outcome": "done"}'::jsonb,
      'normal',
      null,
      array['inbox']::text[],
      ${opts.newest}::timestamptz - make_interval(mins => g),
      case when g % ${opts.unreadEvery}::int = 0 then null
        else ${opts.newest}::timestamptz - make_interval(mins => g) + interval '1 hour' end
    from generate_series(1, ${count}::int) as g
  `.execute(db);
}
