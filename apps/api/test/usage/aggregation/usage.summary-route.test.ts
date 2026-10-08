/**
 * `GET /v1/workspaces/{id}/usage/summary` (B075 acceptance 7 and 8, card test
 * usage.summary-route.test.ts): a member gets 200 (owner, admin, member, billing), a guest 403, a
 * non-member 404, all by RBAC over the membership store; it needs `billing:read`. The body is a
 * valid `api/UsageSummary` (`workspace`, `period`, `items` for agent_minutes, tokens, queue_items,
 * relay_bytes and seats) plus the card's `usage`, `limits` and `warnings` (which carry
 * hosted_minutes_month); `seats` is the seats in use from B030's port (stubbed), not Stripe's
 * quantity; events from 3 users of the workspace are pooled.
 */
import { validate } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { UsageSummaryService } from '../../../src/modules/usage/reader.js';
import { usageSummaryRoutes } from '../../../src/routes/usage-summary/index.js';
import { asUser, createWorkspace, workspacesApp } from '../../modules/workspaces/helpers.js';
import { newId, usageHarness } from './helpers.js';

const READ = 'billing:read';

async function summaryApp() {
  const h = usageHarness();
  const seats = { usage: () => Promise.resolve({ members: 3 }) };
  const summary = new UsageSummaryService({
    counters: h.counters,
    quota: h.quota,
    seats,
    entitlements: h.service,
    clock: h.clock.read,
  });
  const app = await workspacesApp({
    beforeReady: async (instance) => {
      await instance.register(usageSummaryRoutes, { summary });
    },
  });
  return { ...app, h };
}

describe('GET /v1/workspaces/{id}/usage/summary', () => {
  it('answers members, refuses guests with 403 and outsiders with 404', async () => {
    const { app, store, h } = await summaryApp();
    const owner = newId('usr');
    store.addUser(owner);
    const ws = (await createWorkspace(app, owner)).id;
    h.live.add(ws);
    const get = (user: string, scopes = READ) =>
      app.inject({
        method: 'GET',
        url: `/v1/workspaces/${ws}/usage/summary`,
        headers: asUser(user, scopes),
      });
    expect((await get(owner)).statusCode).toBe(200);
    for (const [role, status] of [
      ['admin', 200],
      ['member', 200],
      ['billing', 200],
      ['guest', 403],
    ] as [WorkspaceRole, number][]) {
      const user = newId('usr');
      store.join(ws, user, role);
      expect((await get(user)).statusCode, role).toBe(status);
    }
    expect((await get(newId('usr'))).statusCode).toBe(404);
    expect((await get(owner, 'workspaces:read')).statusCode).toBe(403);
    await app.close();
  });

  it('answers a UsageSummary with pooled usage and seats in use from B030', async () => {
    const { app, store, h } = await summaryApp();
    const owner = newId('usr');
    store.addUser(owner);
    const ws = (await createWorkspace(app, owner)).id;
    h.live.add(ws);
    const month = calendarMonth(new Date(h.clock.now));
    // A team with 4 add-on seats in Stripe; 3 seats are in use.
    await h.service.applySubscriptionState(ws, {
      plan: 'team',
      status: 'active',
      period: month,
      past_due_since: null,
      addon_seats: 4,
    });
    const received = new Date(h.clock.now - 120_000);
    for (const qty of [10, 20, 30])
      h.ingest(ws, 'agent_minutes', qty, new Date(h.clock.now - 60_000), received);
    h.ingest(ws, 'tokens_in', 1000, new Date(h.clock.now - 60_000), received);
    h.ingest(ws, 'tokens_out', 500, new Date(h.clock.now - 60_000), received);
    h.relay.record(ws, 'hosted_minutes', 25_000);
    h.relay.record(ws, 'queue_items', 7);
    await h.aggregator.run();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/usage/summary`,
      headers: asUser(owner, READ),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(validate('api/UsageSummary', body).ok).toBe(true);
    expect(body).toMatchObject({
      workspace: ws,
      period: { start: month.start.toISOString(), end: month.end.toISOString() },
      items: [
        { metric: 'agent_minutes', used: 60, limit: null, pct: null },
        { metric: 'tokens', used: 1500, limit: null, pct: null },
        { metric: 'queue_items', used: 7, limit: null, pct: null },
        { metric: 'relay_bytes', used: 0, limit: null, pct: null },
        { metric: 'seats', used: 3, limit: 9, pct: 33 },
      ],
      usage: { hosted_minutes_month: 25_000, queue_items_month: 7, seats: 3 },
      limits: { hosted_minutes_month: 30_000, queue_items_month: null, max_seats: 9 },
      warnings: [{ limit: 'hosted_minutes_month', pct: 80 }],
    });
    expect(response.headers['cache-control']).toBe('private, no-cache');
    await app.close();
  });
});
