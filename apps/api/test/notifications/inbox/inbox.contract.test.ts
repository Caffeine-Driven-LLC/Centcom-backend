/**
 * The inbox's responses against the contract (B065 acceptance 6, guardrail "no params or fields
 * beyond CT-NOTIF-PAYLOAD"): list pages validate as `api/NotificationPage` and each item as both
 * `api/Notification` and `notification.schema.json`, with no other field; `read_at` is null for
 * unread items; `params` outside the category's allow-list never leave the server; a row without
 * an action has no `action`; the read response is an `api/Notification` and read-all's an
 * `api/ReadAllResult`. Nothing in a response is display text.
 */
import { validate, validateNotification } from '@centcom/contracts';
import { NOTIFICATION_CATEGORIES } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { PARAM_RULES } from '../../../src/modules/notifications/dispatcher/params.js';
import { inboxPayload } from '../../../src/modules/notifications/inbox/service.js';
import {
  allPages,
  inboxApp,
  inboxRow,
  inboxRows,
  memoryInbox,
  MINUTE_MS,
  newId,
  T0,
} from './helpers.js';

const PAYLOAD_FIELDS = [
  'action',
  'body_key',
  'category',
  'created_at',
  'id',
  'params',
  'priority',
  'read_at',
  'title_key',
];

describe('inbox responses', () => {
  it('validate as NotificationPage and Notification, with no other fields', async () => {
    const user = newId('usr');
    const rows = [
      ...inboxRows(user, 10, { unreadEvery: 3 }),
      inboxRow(user, T0 - 30 * MINUTE_MS, { action: null, priority: 'low' }),
    ];
    const { app, bearerFor } = await inboxApp(memoryInbox(rows).repository);
    const { pages } = await allPages(app, await bearerFor(user), 'limit=4');
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(validate('api/NotificationPage', page).ok).toBe(true);
      expect(Object.keys(page).sort()).toEqual(['data', 'has_more', 'next_cursor']);
      for (const item of page.data) {
        expect(validate('api/Notification', item).ok).toBe(true);
        expect(validateNotification(item).ok).toBe(true);
        for (const key of Object.keys(item)) expect(PAYLOAD_FIELDS).toContain(key);
      }
    }
    const items = pages.flatMap((p) => p.data);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const item of items) {
      const row = byId.get(String(item.id));
      expect(item.read_at === null).toBe(row?.readAt === null);
    }
    const plain = items.find((n) => n.id === rows.at(-1)?.id);
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty('action');
    await app.close();
  });

  it('drops params outside the category allow-list and never sends display text', async () => {
    const user = newId('usr');
    const row = inboxRow(user, T0 - MINUTE_MS, {
      params: { agent: newId('agt'), session: newId('ses'), risk: 'low', path: '/home/x', n: 3 },
    });
    const { app, bearerFor } = await inboxApp(memoryInbox([row]).repository);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: await bearerFor(user),
    });
    const [item] = response.json<{ data: Record<string, unknown>[] }>().data;
    expect(Object.keys(item?.['params'] as object).sort()).toEqual(['agent', 'risk', 'session']);
    expect(response.body).not.toContain('/home/x');
    expect(item?.['title_key']).toBe('notif.approval_needed.title');
    expect(item?.['body_key']).toBe('notif.approval_needed.body');
    expect(item).not.toHaveProperty('title');
    expect(item).not.toHaveProperty('body');
    await app.close();
  });

  it('answers read with a Notification and read-all with a ReadAllResult', async () => {
    const user = newId('usr');
    const row = inboxRow(user, T0 - MINUTE_MS);
    const { app, bearerFor } = await inboxApp(memoryInbox([row]).repository);
    const headers = await bearerFor(user);
    const read = await app.inject({
      method: 'POST',
      url: `/v1/notifications/${row.id}/read`,
      headers,
    });
    expect(validate('api/Notification', read.json()).ok).toBe(true);
    expect(validateNotification(read.json()).ok).toBe(true);
    expect(read.json<{ read_at: string | null }>().read_at).not.toBeNull();
    const all = await app.inject({ method: 'POST', url: '/v1/notifications/read-all', headers });
    expect(validate('api/ReadAllResult', all.json()).ok).toBe(true);
    await app.close();
  });

  it('maps a row of every category to a valid payload with only allow-listed params', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const payload = inboxPayload({
        id: newId('ntf'),
        category,
        params: { unexpected: 'x' },
        priority: 'normal',
        action: { type: 'none' },
        createdAt: new Date(T0),
        readAt: new Date(T0 + MINUTE_MS),
      });
      expect(validateNotification(payload).ok, category).toBe(true);
      expect(payload.params).toEqual({});
      expect(Object.keys(PARAM_RULES[category]).length).toBeGreaterThan(0);
      expect(payload.read_at).toBe(new Date(T0 + MINUTE_MS).toISOString());
    }
  });
});
