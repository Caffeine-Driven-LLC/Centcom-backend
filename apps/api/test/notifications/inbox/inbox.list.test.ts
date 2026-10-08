/**
 * Listing the inbox (B065 acceptance 1, 5 and 8): 120 notifications with 30 unread come 50 a page
 * by default in 3 pages, newest first, each once, with `X-Unread-Count: 30` on every page;
 * `unread=true` gives exactly the 30; ties on `created_at` page by id; a notification arriving
 * between pages neither repeats nor shifts one; only rows holding the `inbox` channel show, and
 * none older than 90 days (not counted either). `limit` outside 1..200 or a bad `unread` is 422;
 * an expired, tampered, other user's or other filter's cursor is 400 `cursor_invalid`. The same
 * scenarios run on Postgres 16 (DATABASE_URL, CI's integration job).
 */
import type { NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createInboxRepository } from '../../../src/modules/notifications/inbox/repository.js';
import {
  INBOX_RETENTION_MS,
  InboxService,
} from '../../../src/modules/notifications/inbox/service.js';
import { testClock } from '../../modules/auth/tokens/helpers.js';
import {
  ADMIN_URL,
  allPages,
  DAY_MS,
  inboxApp,
  inboxRow,
  inboxRows,
  KEYS,
  memoryInbox,
  migratedDatabase,
  MINUTE_MS,
  newId,
  pgInsert,
  pgUser,
  T0,
  type InboxBody,
} from './helpers.js';

const ids = (pages: InboxBody[]): string[] => pages.flatMap((p) => p.data.map((n) => String(n.id)));
const times = (pages: InboxBody[]): number[] =>
  pages.flatMap((p) => p.data.map((n) => Date.parse(String(n.created_at))));

describe('GET /v1/notifications', () => {
  it('pages 120 notifications 50 at a time, newest first, with the unread count', async () => {
    const user = newId('usr');
    const rows = inboxRows(user, 120, { unreadEvery: 4 });
    const { app, bearerFor } = await inboxApp(memoryInbox(rows).repository);
    const { pages, unreadCounts } = await allPages(app, await bearerFor(user));
    expect(pages.map((p) => p.data.length)).toEqual([50, 50, 20]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    expect(ids(pages)).toEqual(rows.map((r) => r.id));
    expect(new Set(ids(pages)).size).toBe(120);
    const t = times(pages);
    expect(t.every((v, i) => i === 0 || (t[i - 1] ?? 0) >= v)).toBe(true);
    expect(unreadCounts).toEqual(['30', '30', '30']);
    await app.close();
  });

  it('lists exactly the 30 unread with unread=true, read_at null on each', async () => {
    const user = newId('usr');
    const rows = inboxRows(user, 120, { unreadEvery: 4 });
    const { app, bearerFor } = await inboxApp(memoryInbox(rows).repository);
    const { pages } = await allPages(app, await bearerFor(user), 'unread=true');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.data).toHaveLength(30);
    expect(pages[0]?.data.every((n) => n.read_at === null)).toBe(true);
    expect(ids(pages)).toEqual(rows.filter((r) => r.readAt === null).map((r) => r.id));
    const all = await allPages(app, await bearerFor(user), 'unread=false');
    expect(ids(all.pages)).toHaveLength(120);
    await app.close();
  });

  it('breaks ties on created_at by id, and a new arrival between pages shifts nothing', async () => {
    const user = newId('usr');
    // 30 rows at one instant, then 30 more a minute apart.
    const rows = [
      ...Array.from({ length: 30 }, () => inboxRow(user, T0 - DAY_MS)),
      ...inboxRows(user, 30, { newest: T0 - 2 * DAY_MS }),
    ];
    const memory = memoryInbox(rows);
    const { app, bearerFor } = await inboxApp(memory.repository);
    const headers = await bearerFor(user);
    const first = (
      await app.inject({ method: 'GET', url: '/v1/notifications?limit=20', headers })
    ).json<InboxBody>();
    rows.push(inboxRow(user, T0 - MINUTE_MS));
    const rest = await allPages(
      app,
      headers,
      `limit=20&cursor=${encodeURIComponent(String(first.next_cursor))}`,
    );
    const seen = ids([first, ...rest.pages]);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    const tied = rows.slice(0, 30).map((r) => r.id);
    expect(seen.slice(0, 30)).toEqual([...tied].sort().reverse());
    await app.close();
  });

  it('shows only inbox rows of the last 90 days, and counts only those', async () => {
    const user = newId('usr');
    const rows = [
      inboxRow(user, T0 - MINUTE_MS),
      inboxRow(user, T0 - INBOX_RETENTION_MS + MINUTE_MS),
      inboxRow(user, T0 - INBOX_RETENTION_MS - MINUTE_MS),
      inboxRow(user, T0 - 100 * DAY_MS),
      inboxRow(user, T0 - 2 * MINUTE_MS, { channels: ['push', 'email'] }),
    ];
    const { app, bearerFor } = await inboxApp(memoryInbox(rows).repository);
    const { pages, unreadCounts } = await allPages(app, await bearerFor(user));
    expect(ids(pages)).toEqual([rows[0]?.id, rows[1]?.id]);
    expect(unreadCounts).toEqual(['2']);
    await app.close();
  });

  it.each([
    ['limit=201', '/limit'],
    ['limit=0', '/limit'],
    ['limit=ten', '/limit'],
    ['unread=yes', '/unread'],
    ['offset=50', '/offset'],
  ])('refuses %s with 422', async (query, pointer) => {
    const { app, bearerFor } = await inboxApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/notifications?${query}`,
      headers: await bearerFor(newId('usr')),
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ code: string; errors: { pointer: string }[] }>();
    expect(body.code).toBe('validation_failed');
    expect(body.errors.map((e) => e.pointer)).toContain(pointer);
    await app.close();
  });

  it('accepts limit=200 and limit=1', async () => {
    const user = newId('usr');
    const { app, bearerFor } = await inboxApp(memoryInbox(inboxRows(user, 250)).repository);
    const headers = await bearerFor(user);
    for (const [limit, size] of [
      [200, 200],
      [1, 1],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/notifications?limit=${limit}`,
        headers,
      });
      expect(response.json<InboxBody>().data).toHaveLength(size);
    }
    await app.close();
  });

  it('refuses an expired, tampered, other filter or other user cursor with 400 cursor_invalid', async () => {
    const alice = newId('usr');
    const bob = newId('usr');
    const clock = testClock();
    const memory = memoryInbox([...inboxRows(alice, 120), ...inboxRows(bob, 120)]);
    const { app, bearerFor } = await inboxApp(memory.repository, clock);
    const asAlice = await bearerFor(alice);
    const cursorOf = async (query: string, headers: Record<string, string>) =>
      (
        await app.inject({ method: 'GET', url: `/v1/notifications?${query}`, headers })
      ).json<InboxBody>().next_cursor ?? '';
    const cursor = await cursorOf('limit=10', asAlice);
    const unreadCursor = await cursorOf('limit=10&unread=true', asAlice);
    const get = async (query: string, headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/v1/notifications?${query}`, headers });
    const refused = async (query: string, headers: Record<string, string>, why: string) => {
      const response = await get(query, headers);
      expect(response.statusCode, query).toBe(400);
      const body = response.json<{ code: string; errors: { code: string }[] }>();
      expect(body.code).toBe('cursor_invalid');
      expect(body.errors[0]?.code).toBe(why);
    };
    expect((await get(`cursor=${cursor}`, asAlice)).statusCode).toBe(200);
    await refused(`cursor=${cursor}&unread=true`, asAlice, 'mismatch');
    await refused(`cursor=${unreadCursor}`, asAlice, 'mismatch');
    await refused(`cursor=${cursor}`, await bearerFor(bob), 'mismatch');
    await refused(`cursor=${cursor.slice(0, -2)}xx`, asAlice, 'invalid');
    await refused('cursor=not*a*cursor', asAlice, 'invalid');
    clock.advance(DAY_MS + 1);
    await refused(`cursor=${cursor}`, await bearerFor(alice), 'expired');
    await app.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('the inbox list on Postgres 16', () => {
  it('pages, filters, orders and hides old rows as in memory', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<NotificationDb>;
      const user = await pgUser(t.db);
      const other = await pgUser(t.db);
      const rows = inboxRows(user, 120, { unreadEvery: 4 });
      const tied = Array.from({ length: 5 }, () => inboxRow(user, T0 - 3 * DAY_MS));
      const hidden = [
        inboxRow(user, T0 - INBOX_RETENTION_MS - MINUTE_MS),
        inboxRow(user, T0 - 2 * MINUTE_MS, { channels: ['email'] }),
      ];
      await pgInsert(t.db, [...rows, ...tied, ...hidden, ...inboxRows(other, 40)]);
      const inbox = new InboxService({
        repository: createInboxRepository(db),
        cursorKeys: KEYS,
        clock: () => T0,
      });
      const now = new Date(T0);

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      do {
        const { page, unreadCount } = await inbox.list(
          user,
          { unread: false, limit: 50, ...(cursor === undefined ? {} : { cursor }) },
          now,
        );
        expect(unreadCount).toBe(35);
        sizes.push(page.data.length);
        seen.push(...page.data.map((n) => n.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(sizes).toEqual([50, 50, 25]);
      expect(seen.slice(0, 120)).toEqual(rows.map((r) => r.id));
      expect(seen.slice(120)).toEqual(
        tied
          .map((r) => r.id)
          .sort()
          .reverse(),
      );

      const unread = await inbox.list(user, { unread: true, limit: 50 }, now);
      expect(unread.page.data).toHaveLength(35);
      expect(unread.page.has_more).toBe(false);
      expect(unread.page.data.every((n) => n.read_at === null)).toBe(true);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
