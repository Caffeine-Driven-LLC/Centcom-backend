/**
 * The route-level checks (B080 acceptance 5 and 6): `requireEntitlement('relay_access')` on a plan
 * without it is 403 `entitlement_required`; a count reached is 403 with the registry's code for it
 * (`webhook_limit_reached` for `webhooks_max`), a count of 0 refusing even with nothing in use;
 * `requireQuota('hosted_minutes_month')` at the limit is 429 `quota_exceeded` with `retry_after_s`
 * equal to the seconds until `period.end` and a matching `Retry-After`; a null limit never
 * refuses; LAN is never checked; with the entitlements unreadable, 503, never through.
 */
import { newId, validateProblem } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CachedEntitlements } from '../../src/modules/entitlements/enforcement.js';
import { EntitlementService } from '../../src/modules/entitlements/service.js';
import { calendarMonth } from '../../src/modules/usage/period.js';
import { QuotaService } from '../../src/modules/usage/quota.js';
import {
  entitlementsPlugin,
  requireEntitlement,
  requireQuota,
} from '../../src/plugins/entitlements.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { captureLogger } from '../helpers.js';
import { MemoryCounterStore } from '../usage/aggregation/helpers.js';
import { Clock, MemoryEntitlementRepository } from './helpers.js';

async function app() {
  const clock = new Clock();
  const live = new Set<string>();
  const source = new EntitlementService({
    repository: new MemoryEntitlementRepository((id) => live.has(id)),
    events: createMemoryRedis().pubsub,
    clock: clock.read,
  });
  const counters = new MemoryCounterStore();
  const quota = new QuotaService({
    counters,
    entitlements: source,
    rev: source,
    clock: clock.read,
  });
  let down = false;
  const enforcer = new CachedEntitlements({
    source: { get: (ws) => (down ? Promise.reject(new Error('db down')) : source.get(ws)) },
    quota: {
      check: (ws, key) => (down ? Promise.reject(new Error('db down')) : quota.check(ws, key)),
    },
    clock: clock.read,
  });
  const captured = captureLogger();
  const server = fastify({ logger: false });
  await server.register(requestContextPlugin, { logger: captured.logger });
  await server.register(errorHandlerPlugin, { logger: captured.logger });
  await server.register(entitlementsPlugin, { enforcer });
  server.post(
    '/v1/workspaces/:id/sessions',
    { preHandler: [requireEntitlement('relay_access'), requireQuota('hosted_minutes_month')] },
    () => ({ ok: true }),
  );
  server.post(
    '/v1/workspaces/:id/webhooks',
    {
      preHandler: requireEntitlement('webhooks_max', {
        current: (r) => Number(r.headers['x-in-use'] ?? 0),
      }),
    },
    () => ({ ok: true }),
  );
  server.post(
    '/v1/workspaces/:id/queue',
    { preHandler: requireQuota('queue_items_month') },
    () => ({ ok: true }),
  );
  server.post('/lan/:id', { preHandler: requireEntitlement('lan_multiplayer') }, () => ({
    ok: true,
  }));
  await server.ready();
  const workspace = (plan?: 'pro' | 'team') => {
    const id = newId('wsp');
    live.add(id);
    return plan === undefined
      ? Promise.resolve(id)
      : source
          .applySubscriptionState(id, {
            plan,
            status: 'active',
            period: calendarMonth(new Date(clock.now)),
            past_due_since: null,
            addon_seats: 0,
          })
          .then(() => id);
  };
  return { server, clock, counters, workspace, setDown: (d: boolean) => (down = d) };
}

describe('requireEntitlement and requireQuota', () => {
  it('answers 403 entitlement_required for a plan without relay_access', async () => {
    const t = await app();
    const free = await t.workspace();
    const res = await t.server.inject({ method: 'POST', url: `/v1/workspaces/${free}/sessions` });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('entitlement_required');
    expect(validateProblem(res.json()).ok).toBe(true);
    const pro = await t.workspace('pro');
    expect(
      (await t.server.inject({ method: 'POST', url: `/v1/workspaces/${pro}/sessions` })).statusCode,
    ).toBe(200);
    await t.server.close();
  });

  it('answers 429 quota_exceeded at the limit, retry_after_s and Retry-After to period.end', async () => {
    const t = await app();
    const pro = await t.workspace('pro');
    const month = calendarMonth(new Date(t.clock.now));
    await t.counters.add([
      { workspaceId: pro, periodStart: month.start, metric: 'relay.hosted_minutes', amount: 6000 },
    ]);
    const res = await t.server.inject({ method: 'POST', url: `/v1/workspaces/${pro}/sessions` });
    expect(res.statusCode).toBe(429);
    const body = res.json<{ code: string; retry_after_s: number }>();
    const expected = Math.ceil((month.end.getTime() - t.clock.now) / 1000);
    expect(body.code).toBe('quota_exceeded');
    expect(body.retry_after_s).toBe(expected);
    expect(res.headers['retry-after']).toBe(String(expected));
    await t.server.close();
  });

  it('refuses a count reached with its own code, a count of 0 always, and never a null limit', async () => {
    const t = await app();
    const free = await t.workspace();
    const zero = await t.server.inject({ method: 'POST', url: `/v1/workspaces/${free}/webhooks` });
    expect(zero.statusCode).toBe(403);
    expect(zero.json<{ code: string }>().code).toBe('webhook_limit_reached');
    const pro = await t.workspace('pro');
    const ok = await t.server.inject({
      method: 'POST',
      url: `/v1/workspaces/${pro}/webhooks`,
      headers: { 'x-in-use': '1' },
    });
    expect(ok.statusCode).toBe(200);
    const full = await t.server.inject({
      method: 'POST',
      url: `/v1/workspaces/${pro}/webhooks`,
      headers: { 'x-in-use': '2' },
    });
    expect(full.json<{ code: string }>().code).toBe('webhook_limit_reached');
    const team = await t.workspace('team');
    await t.counters.add([
      {
        workspaceId: team,
        periodStart: calendarMonth(new Date(t.clock.now)).start,
        metric: 'relay.queue_items',
        amount: 1e9,
      },
    ]);
    expect(
      (await t.server.inject({ method: 'POST', url: `/v1/workspaces/${team}/queue` })).statusCode,
    ).toBe(200);
    await t.server.close();
  });

  it('never checks LAN, and fails closed with 503 when entitlements cannot be read', async () => {
    const t = await app();
    const pro = await t.workspace('pro');
    t.setDown(true);
    expect((await t.server.inject({ method: 'POST', url: `/lan/${pro}` })).statusCode).toBe(200);
    const res = await t.server.inject({ method: 'POST', url: `/v1/workspaces/${pro}/sessions` });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string; retry_after_s: number }>()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 5,
    });
    await t.server.close();
  });
});
