/**
 * Marking read (B065 acceptance 3 and 4, guardrail "bounded batches", failure mode "database
 * timeout"): reading twice answers 200 both times with the first `read_at`; read-all marks 1 200
 * unread rows in statements of at most 500 and answers the exact count, then 0; it leaves rows that
 * arrive after it started unread; the read-all statement is one bounded, lock-skipping batch.
 * A database timeout or lost connection is 503 with `retry_after_s`, and a read-all that fails
 * part-way answers 503, not a partial count. On Postgres 16 (DATABASE_URL), the same with real
 * rows and timestamps.
 */
import type { NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createInboxRepository } from '../../../src/modules/notifications/inbox/repository.js';
import {
  InboxService,
  READ_ALL_BATCH_SIZE,
} from '../../../src/modules/notifications/inbox/service.js';
import { testClock } from '../../modules/auth/tokens/helpers.js';
import { scriptedDb } from '../../modules/users/helpers.js';
import {
  ADMIN_URL,
  inboxApp,
  inboxRow,
  inboxRows,
  KEYS,
  memoryInbox,
  migratedDatabase,
  MINUTE_MS,
  newId,
  pgBulk,
  pgInsert,
  pgUser,
  T0,
} from './helpers.js';

const timeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  });
const lost = () =>
  Object.assign(new Error('Connection terminated unexpectedly'), {
    code: 'ECONNRESET',
  });

describe('POST /v1/notifications/{id}/read', () => {
  it('answers 200 twice and keeps the first read_at', async () => {
    const user = newId('usr');
    const row = inboxRow(user, T0 - MINUTE_MS);
    const clock = testClock();
    const { app, bearerFor } = await inboxApp(memoryInbox([row]).repository, clock);
    const headers = await bearerFor(user);
    const first = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${row.id}/read`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ read_at: string }>().read_at).toBe(new Date(T0).toISOString());
    clock.advance(5 * MINUTE_MS);
    const second = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${row.id}/read`,
      headers,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    await app.close();
  });
});

describe('POST /v1/notifications/read-all', () => {
  it('marks 1 200 in batches of at most 500 and answers the count, then 0', async () => {
    const user = newId('usr');
    const rows = inboxRows(user, 1300, { unreadEvery: 1 }).map((r, i) =>
      i % 13 === 0 ? { ...r, readAt: new Date(T0 - MINUTE_MS) } : r,
    );
    const unread = rows.filter((r) => r.readAt === null).length;
    expect(unread).toBe(1200);
    const memory = memoryInbox(rows);
    const { app, bearerFor } = await inboxApp(memory.repository);
    const headers = await bearerFor(user);
    const first = await app.inject({ method: 'POST', url: '/v1/notifications/read-all', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ updated: 1200 });
    expect(memory.batches).toEqual([500, 500, 200]);
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
    const second = await app.inject({ method: 'POST', url: '/v1/notifications/read-all', headers });
    expect(second.json()).toEqual({ updated: 0 });
    const count = await app.inject({ method: 'GET', url: '/v1/notifications', headers });
    expect(count.headers['x-unread-count']).toBe('0');
    await app.close();
  });

  it('runs one more batch when the last one was exactly full', async () => {
    const user = newId('usr');
    const memory = memoryInbox(inboxRows(user, 1000, { unreadEvery: 1 }));
    const inbox = new InboxService({ repository: memory.repository, cursorKeys: KEYS });
    expect(await inbox.markAllRead(user, new Date(T0))).toEqual({ updated: 1000 });
    expect(memory.batches).toEqual([500, 500, 0]);
  });

  it('leaves notifications that arrive after it started unread', async () => {
    const user = newId('usr');
    const later = inboxRow(user, T0 + MINUTE_MS);
    const memory = memoryInbox([...inboxRows(user, 3, { unreadEvery: 1 }), later]);
    const inbox = new InboxService({ repository: memory.repository, cursorKeys: KEYS });
    expect(await inbox.markAllRead(user, new Date(T0))).toEqual({ updated: 3 });
    expect(later.readAt).toBeNull();
  });

  it('runs each batch as one bounded statement that skips locked rows', async () => {
    const user = newId('usr');
    const seen: { sql: string; parameters: readonly unknown[] }[] = [];
    const { db } = scriptedDb((query) => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      return { affected: 0n };
    });
    const repository = createInboxRepository(db as unknown as Kysely<NotificationDb>);
    await new InboxService({ repository, cursorKeys: KEYS }).markAllRead(user, new Date(T0));
    expect(seen).toHaveLength(1);
    const [statement] = seen;
    expect(statement?.sql).toMatch(/limit \$\d+\s+for update skip locked/);
    expect(statement?.parameters).toContain(READ_ALL_BATCH_SIZE);
    expect(statement?.sql).toContain('created_at <= $');
    expect(statement?.sql).not.toMatch(/\bbegin\b/);
  });
});

describe('database failures', () => {
  it.each([
    ['a statement timeout', timeout],
    ['a lost connection', lost],
  ])('answers 503 with retry_after_s for %s', async (_case, error) => {
    const user = newId('usr');
    const memory = memoryInbox(inboxRows(user, 3), () => error());
    const { app, bearerFor } = await inboxApp(memory.repository);
    const headers = await bearerFor(user);
    for (const [method, url] of [
      ['GET', '/v1/notifications'],
      ['POST', `/v1/notifications/${newId('ntf')}/read`],
      ['POST', '/v1/notifications/read-all'],
    ] as const) {
      const response = await app.inject({ method, url, headers });
      expect(response.statusCode, url).toBe(503);
      const body = response.json<{ code: string; retry_after_s: number }>();
      expect(body.code).toBe('service_unavailable');
      expect(body.retry_after_s).toBeGreaterThan(0);
      expect(response.body).not.toContain('statement timeout');
    }
    await app.close();
  });

  it('answers 503, not a partial count, when a later read-all batch fails', async () => {
    const user = newId('usr');
    const memory = memoryInbox(inboxRows(user, 1200, { unreadEvery: 1 }), (op, call) =>
      op === 'markReadBatch' && call === 2 ? timeout() : undefined,
    );
    const { app, bearerFor } = await inboxApp(memory.repository);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read-all',
      headers: await bearerFor(user),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('updated');
    await app.close();
  });

  it('passes other errors on as they are', async () => {
    const user = newId('usr');
    const memory = memoryInbox([], () => new TypeError('a bug'));
    const inbox = new InboxService({ repository: memory.repository, cursorKeys: KEYS });
    await expect(inbox.markAllRead(user, new Date(T0))).rejects.toThrow(TypeError);
  });
});

describe.runIf(ADMIN_URL !== undefined)('marking read on Postgres 16', () => {
  it('keeps the first read_at, and marks 1 200 then 0 on read-all', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<NotificationDb>;
      const user = await pgUser(t.db);
      const row = inboxRow(user, T0 - MINUTE_MS);
      const later = inboxRow(user, T0 + 10 * MINUTE_MS);
      await pgInsert(t.db, [row, later]);
      await pgBulk(t.db, user, 1300, { newest: new Date(T0 - 2 * MINUTE_MS), unreadEvery: 1 });
      // 100 of the bulk rows already read.
      await db
        .updateTable('notifications')
        .set({ read_at: new Date(T0 - MINUTE_MS) })
        .where('event_id', 'like', 'bulk-%')
        .where('id', '<=', 'ntf_10000000000000000000000100')
        .execute();
      const inbox = new InboxService({
        repository: createInboxRepository(db),
        cursorKeys: KEYS,
        clock: () => T0,
      });
      const first = await inbox.markRead(user, row.id, new Date(T0));
      const second = await inbox.markRead(user, row.id, new Date(T0 + 5 * MINUTE_MS));
      expect(first.read_at).toBe(new Date(T0).toISOString());
      expect(second).toEqual(first);

      expect(await inbox.markAllRead(user, new Date(T0))).toEqual({ updated: 1200 });
      expect(await inbox.markAllRead(user, new Date(T0))).toEqual({ updated: 0 });
      const left = await inbox.list(
        user,
        { unread: true, limit: 10 },
        new Date(T0 + 20 * MINUTE_MS),
      );
      expect(left.page.data.map((n) => n.id)).toEqual([later.id]);
      expect(left.unreadCount).toBe(1);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
