/**
 * Enforcement (B080 acceptance 1, 4, 6, 7 and 8, guardrails, failure modes), over B069's real
 * entitlement service on an in-memory repository, real Redis pub/sub (in memory) and B075's real
 * quota service:
 * - a change (rev 41 → 42 style) published by B069, or by `invalidate`, reaches every process's
 *   cache within 1 s; without a message an entry is never older than 30 s;
 * - past_due keeps the plan's limits until `grace_until`, and 1 ms after it reads free and `none`
 *   through the cache, with no job run; canceled reads `none` after `period.end`;
 * - a null limit never denies, a count limit of 0 always does; `lan_multiplayer` is always true
 *   and never denied; unknown keys are kept on read and never enforced;
 * - metered limits are checked against B075's counters, not the cached `usage`;
 * - with Postgres down and no fresh entry, reads and hosted checks fail closed with 503.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type PubSub } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { CachedEntitlements } from '../../src/modules/entitlements/enforcement.js';
import type { Entitlements } from '../../src/modules/entitlements/ports.js';
import { EntitlementService } from '../../src/modules/entitlements/service.js';
import { calendarMonth } from '../../src/modules/usage/period.js';
import { QuotaService } from '../../src/modules/usage/quota.js';
import { MemoryCounterStore } from '../usage/aggregation/helpers.js';
import { Clock, MemoryEntitlementRepository } from './helpers.js';

/** B069 over memory; with `silentSource`, its own announcements go where no cache listens. */
function world(opts: { silentSource?: boolean } = {}) {
  const redis = createMemoryRedis();
  const clock = new Clock();
  const live = new Set<string>();
  const repository = new MemoryEntitlementRepository((id) => live.has(id));
  const events = opts.silentSource === true ? createMemoryRedis().pubsub : redis.pubsub;
  const source = new EntitlementService({ repository, events, clock: clock.read });
  const counters = new MemoryCounterStore();
  const quota = new QuotaService({
    counters,
    entitlements: source,
    rev: source,
    clock: clock.read,
  });
  let down = false;
  const reads = { count: 0 };
  const flaky = {
    get: (ws: string) => {
      reads.count += 1;
      return down ? Promise.reject(new Error('connection terminated')) : source.get(ws);
    },
  };
  const instance = (pubsub: Pick<PubSub, 'publish' | 'subscribe'> = redis.pubsub) =>
    new CachedEntitlements({ source: flaky, quota, pubsub, clock: clock.read });
  const workspace = () => {
    const id = newId('wsp');
    live.add(id);
    return id;
  };
  return {
    redis,
    clock,
    source,
    counters,
    quota,
    reads,
    instance,
    workspace,
    setDown: (d: boolean) => {
      down = d;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('CachedEntitlements', () => {
  it('reaches every process within 1 s of a change, and is never older than 30 s', async () => {
    const w = world();
    const ws = w.workspace();
    const [a, b] = [w.instance(), w.instance()];
    await a.start();
    await b.start();
    const before = await a.get(ws);
    await b.get(ws);
    const started = Date.now();
    await w.source.applySubscriptionState(ws, {
      plan: 'pro',
      status: 'active',
      period: calendarMonth(new Date(w.clock.now)),
      past_due_since: null,
      addon_seats: 0,
    });
    await settle();
    const [ra, rb] = [await a.get(ws), await b.get(ws)];
    expect(Date.now() - started).toBeLessThan(1_000);
    const current = (await w.source.get(ws))?.rev;
    expect(current).toBeGreaterThan(before.rev);
    expect(ra.rev).toBe(current);
    expect(rb.rev).toBe(current);
    expect(ra.plan).toBe('pro');
    await a.stop();
    await b.stop();
  });

  it("carries one process's invalidate to the others, and reloads unannounced changes at 30 s", async () => {
    const w = world({ silentSource: true });
    const ws = w.workspace();
    const [a, b] = [w.instance(), w.instance()];
    await a.start();
    await b.start();
    const first = (await a.get(ws)).rev;
    await b.get(ws);
    await w.source.bumpRev(ws, 'admin');
    expect((await a.get(ws)).rev).toBe(first);
    await b.invalidate(ws);
    await settle();
    const second = (await w.source.get(ws))?.rev;
    expect((await a.get(ws)).rev).toBe(second);

    // Without any message, an entry is reloaded at 30 s, and not before.
    await w.source.bumpRev(ws, 'admin');
    w.clock.advance(29_999);
    expect((await a.get(ws)).rev).toBe(second);
    w.clock.advance(1);
    expect((await a.get(ws)).rev).toBe((second ?? 0) + 1);
    await a.stop();
    await b.stop();
  });

  it('reads past_due as the plan until grace_until and none 1 ms after, through the cache', async () => {
    const w = world();
    const ws = w.workspace();
    const cache = w.instance();
    const since = new Date(w.clock.now - 6 * 24 * 60 * 60 * 1000);
    await w.source.applySubscriptionState(ws, {
      plan: 'pro',
      status: 'past_due',
      period: calendarMonth(new Date(w.clock.now)),
      past_due_since: since,
      addon_seats: 0,
    });
    const during = await cache.get(ws);
    expect(during.status).toBe('past_due');
    expect(during.limits.relay_access).toBe(true);
    const grace = Date.parse(during.grace_until ?? '');
    w.clock.now = grace - 1;
    expect((await cache.get(ws)).status).toBe('past_due');
    w.clock.now = grace + 1;
    const after = await cache.get(ws);
    expect(after.status).toBe('none');
    expect(after.plan).toBe('free');
    expect(after.limits.relay_access).toBe(false);
    expect(await cache.check(ws, 'relay_access')).toEqual({ allowed: false, reason: 'flag_off' });
  });

  it('reads canceled as none after period.end', async () => {
    const w = world();
    const ws = w.workspace();
    const cache = w.instance();
    const period = { start: new Date(w.clock.now - 1000), end: new Date(w.clock.now + 60_000) };
    await w.source.applySubscriptionState(ws, {
      plan: 'team',
      status: 'canceled',
      period,
      past_due_since: null,
      addon_seats: 0,
    });
    expect((await cache.get(ws)).status).toBe('canceled');
    w.clock.now = period.end.getTime() + 1;
    expect((await cache.get(ws)).status).toBe('none');
  });

  it('never denies a null limit, always denies a count of 0, and never denies LAN', async () => {
    const w = world();
    const free = w.workspace();
    const cache = w.instance();
    expect(await cache.check(free, 'webhooks_max', 0)).toEqual({
      allowed: false,
      reason: 'count_reached',
    });
    expect(await cache.check(free, 'webhooks_max')).toEqual({
      allowed: false,
      reason: 'count_reached',
    });
    expect(await cache.check(free, 'api_keys_max', 0)).toEqual({ allowed: true });
    expect(await cache.check(free, 'api_keys_max', 1)).toEqual({
      allowed: false,
      reason: 'count_reached',
    });
    expect((await cache.get(free)).limits.lan_multiplayer).toBe(true);
    expect(await cache.check(free, 'lan_multiplayer')).toEqual({ allowed: true });

    const team = w.workspace();
    await w.source.applySubscriptionState(team, {
      plan: 'team',
      status: 'active',
      period: calendarMonth(new Date(w.clock.now)),
      past_due_since: null,
      addon_seats: 0,
    });
    expect((await cache.get(team)).limits.queue_items_month).toBeNull();
    expect(await cache.check(team, 'queue_items_month')).toEqual({ allowed: true });
    w.counters.add([
      {
        workspaceId: team,
        periodStart: calendarMonth(new Date(w.clock.now)).start,
        metric: 'relay.queue_items',
        amount: 10_000_000,
      },
    ]);
    expect(await cache.check(team, 'queue_items_month')).toEqual({ allowed: true });
    // LAN never reaches the store: allowed even with everything down.
    w.setDown(true);
    expect(await cache.check(newId('wsp'), 'lan_multiplayer')).toEqual({ allowed: true });
  });

  it('checks metered limits against B075 counters, not the cached usage', async () => {
    const w = world();
    const ws = w.workspace();
    const cache = w.instance();
    const month = calendarMonth(new Date(w.clock.now));
    await w.source.applySubscriptionState(ws, {
      plan: 'pro',
      status: 'active',
      period: month,
      past_due_since: null,
      addon_seats: 0,
    });
    expect(await cache.check(ws, 'hosted_minutes_month')).toEqual({ allowed: true });
    await cache.get(ws); // cached with no usage
    w.counters.add([
      { workspaceId: ws, periodStart: month.start, metric: 'relay.hosted_minutes', amount: 6000 },
    ]);
    expect(await cache.check(ws, 'hosted_minutes_month')).toEqual({
      allowed: false,
      reason: 'quota_reached',
      retry_after_s: Math.ceil((month.end.getTime() - w.clock.now) / 1000),
    });
  });

  it('keeps unknown limit keys on read and never enforces them', async () => {
    const w = world();
    const ws = w.workspace();
    const extra = {
      ...(await w.source.get(ws)),
      limits: { ...(await w.source.get(ws))?.limits, gpu_hours: 0 },
    } as Entitlements;
    const cache = new CachedEntitlements({
      source: { get: () => Promise.resolve(extra) },
      quota: w.quota,
    });
    expect(((await cache.get(ws)).limits as Record<string, unknown>)['gpu_hours']).toBe(0);
    expect(await cache.check(ws, 'gpu_hours' as never)).toEqual({ allowed: true });
  });

  it('fails closed with 503 when Postgres is down and nothing fresh is cached, and caches no failure', async () => {
    const w = world();
    const ws = w.workspace();
    const cache = w.instance();
    w.setDown(true);
    await expect(cache.get(ws)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(cache.check(ws, 'relay_access')).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(cache.check(ws, 'max_concurrent_sessions', 0)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    w.setDown(false);
    expect((await cache.get(ws)).plan).toBe('free');
    // A fresh entry keeps serving while Postgres is down.
    w.setDown(true);
    expect((await cache.get(ws)).plan).toBe('free');
    w.clock.advance(30_000);
    await expect(cache.get(ws)).rejects.toMatchObject({
      code: 'service_unavailable',
      retryAfterS: 5,
    });
  });
});
