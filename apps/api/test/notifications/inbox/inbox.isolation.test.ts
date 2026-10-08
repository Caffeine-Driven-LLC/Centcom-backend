/**
 * Per-user isolation (B065 acceptance 2 and 7, the failure mode "invalid id in the path is 404"):
 * user A reading B's notification gets 404 and never sees it listed; A's read-all leaves B's rows
 * unread; a malformed or unknown id is 404 (not 400). Every statement the repository runs names
 * the caller's user id. Only a user token with `profile` gets in: an API key is 403 (also one
 * holding `profile`), a token without `profile` is 403, none is 401, and a bad or expired token is
 * 401 `token_invalid` or `token_expired`. On Postgres 16 (DATABASE_URL), the same with real rows.
 */
import type { NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createInboxRepository } from '../../../src/modules/notifications/inbox/repository.js';
import { InboxService } from '../../../src/modules/notifications/inbox/service.js';
import { scriptedDb } from '../../modules/users/helpers.js';
import {
  ADMIN_URL,
  allPages,
  inboxApp,
  inboxRows,
  KEYS,
  memoryInbox,
  migratedDatabase,
  newId,
  pgInsert,
  pgUser,
  T0,
} from './helpers.js';

describe('isolation between users', () => {
  it("answers 404 for another user's notification and never lists it", async () => {
    const alice = newId('usr');
    const bob = newId('usr');
    const bobs = inboxRows(bob, 5);
    const memory = memoryInbox([...inboxRows(alice, 5), ...bobs]);
    const { app, bearerFor } = await inboxApp(memory.repository);
    const asAlice = await bearerFor(alice);
    const target = bobs[0]?.id ?? '';
    const response = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${target}/read`,
      headers: asAlice,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('not_found');
    expect(bobs[0]?.readAt).toBeNull();
    const listed = (await allPages(app, asAlice)).pages.flatMap((p) => p.data.map((n) => n.id));
    expect(listed).toHaveLength(5);
    expect(listed.some((id) => bobs.some((b) => b.id === id))).toBe(false);
    await app.close();
  });

  it("marks only the caller's rows on read-all", async () => {
    const alice = newId('usr');
    const bob = newId('usr');
    const bobs = inboxRows(bob, 8, { unreadEvery: 1 });
    const memory = memoryInbox([...inboxRows(alice, 8, { unreadEvery: 1 }), ...bobs]);
    const { app, bearerFor } = await inboxApp(memory.repository);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read-all',
      headers: await bearerFor(alice),
    });
    expect(response.json()).toEqual({ updated: 8 });
    expect(bobs.every((r) => r.readAt === null)).toBe(true);
    await app.close();
  });

  it.each([['not-an-id'], ['ntf_short'], ['usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W'], ['%00']])(
    'answers 404 for the id %s without asking the database',
    async (id) => {
      const memory = memoryInbox([]);
      const { app, bearerFor } = await inboxApp(memory.repository);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${id}/read`,
        headers: await bearerFor(newId('usr')),
      });
      expect(response.statusCode).toBe(404);
      expect(memory.calls.markRead).toBe(0);
      await app.close();
    },
  );

  it('answers 404 for an unknown well-formed id', async () => {
    const { app, bearerFor } = await inboxApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${newId('ntf')}/read`,
      headers: await bearerFor(newId('usr')),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("names the caller's user id in every statement", async () => {
    const user = newId('usr');
    const seen: { sql: string; parameters: readonly unknown[] }[] = [];
    const { db } = scriptedDb((query) => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      return { rows: [], affected: 0n };
    });
    const repository = createInboxRepository(db as unknown as Kysely<NotificationDb>);
    const now = new Date(T0);
    const page = { limit: 10, sort: 'created', filterHash: 'h', keys: KEYS, now: T0 };
    await repository.list(user, { unread: true, since: now, page });
    await repository.list(user, { unread: false, since: now, page });
    await repository.unreadCount(user, now);
    await repository.markRead(user, newId('ntf'), now, now);
    await repository.markReadBatch(user, now, now, 500);
    expect(seen).toHaveLength(6);
    for (const statement of seen) {
      expect(statement.sql).toMatch(/"?user_id"? = \$\d+/);
      expect(statement.parameters).toContain(user);
      expect(statement.sql).toContain(`'inbox' = any (channels)`);
    }
  });
});

describe('who may use the inbox', () => {
  const routes = [
    ['GET', '/v1/notifications'],
    ['POST', '/v1/notifications/read-all'],
    ['POST', '/v1/notifications/ntf_01JA3Z8K2M5N7P9Q0R1S2T3V4W/read'],
  ] as const;

  it.each(routes)(
    '%s %s: 403 for API keys and tokens without profile, 401 without a token',
    async (method, url) => {
      const { app, bearerFor } = await inboxApp();
      const key = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer cen_live_${'k'.repeat(32)}` },
      });
      expect(key.statusCode).toBe(403);
      expect(key.json<{ code: string }>().code).toBe('forbidden');
      const scoped = await app.inject({
        method,
        url,
        headers: await bearerFor(newId('usr'), ['sessions:read']),
      });
      expect(scoped.statusCode).toBe(403);
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      await app.close();
    },
  );

  it('answers 401 token_invalid for a bad token and token_expired for an old one', async () => {
    const { app, bearerFor, clock } = await inboxApp();
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.e30.c2ln' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json<{ code: string }>().code).toBe('token_invalid');
    const headers = await bearerFor(newId('usr'));
    clock.advance(16 * 60 * 1000);
    const old = await app.inject({ method: 'GET', url: '/v1/notifications', headers });
    expect(old.statusCode).toBe(401);
    expect(old.json<{ code: string }>().code).toBe('token_expired');
    await app.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('isolation on Postgres 16', () => {
  it("never reads, lists or marks another user's rows", async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<NotificationDb>;
      const alice = await pgUser(t.db);
      const bob = await pgUser(t.db);
      const bobs = inboxRows(bob, 6, { unreadEvery: 1 });
      await pgInsert(t.db, [...inboxRows(alice, 6, { unreadEvery: 1 }), ...bobs]);
      const inbox = new InboxService({
        repository: createInboxRepository(db),
        cursorKeys: KEYS,
        clock: () => T0,
      });
      const now = new Date(T0);
      await expect(inbox.markRead(alice, bobs[0]?.id ?? '', now)).rejects.toMatchObject({
        code: 'not_found',
      });
      const { page, unreadCount } = await inbox.list(alice, { unread: false, limit: 50 }, now);
      expect(page.data).toHaveLength(6);
      expect(unreadCount).toBe(6);
      expect(page.data.some((n) => bobs.some((b) => b.id === n.id))).toBe(false);
      expect(await inbox.markAllRead(alice, now)).toEqual({ updated: 6 });
      const bobsUnread = await db
        .selectFrom('notifications')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', bob)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow();
      expect(Number(bobsUnread.n)).toBe(6);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
