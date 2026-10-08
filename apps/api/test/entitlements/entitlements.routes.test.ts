/**
 * `GET /v1/plans` and `GET /v1/workspaces/{id}/entitlements` (B069, CT-API-BILLING) on B027's
 * test app: the public catalog with integer USD and EUR prices, and the entitlements object by
 * role, with its ETag and 304.
 */
import { newId, validate } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { PLANS_MAX_AGE_S } from '../../src/routes/plans/index.js';
import { SEED_PLANS } from '../../src/modules/entitlements/index.js';
import { asKey, asUser, createWorkspace } from '../modules/workspaces/helpers.js';
import { entitlementsApp } from './helpers.js';

/** Every number in `value`, anywhere. */
const numbers = (value: unknown): number[] =>
  typeof value === 'number'
    ? [value]
    : typeof value === 'object' && value !== null
      ? Object.values(value).flatMap(numbers)
      : [];

describe('GET /v1/plans', () => {
  it('is public: all three plans with USD and EUR integer minor units, no floats', async () => {
    const t = await entitlementsApp();
    const res = await t.app.inject({ url: '/v1/plans' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${PLANS_MAX_AGE_S}`);
    const plans = res.json<Record<string, unknown>[]>();
    expect(plans.map((p) => p['id'])).toEqual(['free', 'pro', 'team']);
    for (const plan of plans) {
      expect(validate('api/Plan', plan).ok).toBe(true);
      const prices = plan['prices'] as { price: { amount: number; currency: string } }[];
      expect(new Set(prices.map((p) => p.price.currency))).toEqual(new Set(['USD', 'EUR']));
      for (const { price } of prices) expect(Number.isSafeInteger(price.amount)).toBe(true);
    }
    expect(numbers(plans).every((n) => Number.isInteger(n))).toBe(true);
    expect(plans[1]).toMatchObject({ id: 'pro', name: 'Pro', limits: SEED_PLANS.pro.limits });
    await t.app.close();
  });

  it('takes limits from the catalog rows', async () => {
    const t = await entitlementsApp();
    const team = t.repository.catalog.find((p) => p.id === 'team');
    if (team !== undefined) team.limits.webhooks_max = 25;
    const plans = (await t.app.inject({ url: '/v1/plans' })).json<{ limits: object }[]>();
    expect(plans[2]?.limits).toMatchObject({ webhooks_max: 25 });
    await t.app.close();
  });
});

describe('GET /v1/workspaces/{id}/entitlements', () => {
  const setup = async (): Promise<
    Awaited<ReturnType<typeof entitlementsApp>> & { id: string; owner: string }
  > => {
    const t = await entitlementsApp();
    const owner = t.store.addUser();
    const { id } = await createWorkspace(t.app, owner);
    return { ...t, id, owner };
  };
  const url = (id: string): string => `/v1/workspaces/${id}/entitlements`;

  it('a member gets 200 with rev and an ETag; the body validates', async () => {
    const t = await setup();
    const member = newId('usr');
    t.store.join(t.id, member, 'member');
    const res = await t.app.inject({ url: url(t.id), headers: asUser(member) });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ workspace: t.id, rev: 0, plan: 'free', status: 'none' });
    expect(res.headers['etag']).toMatch(/^"e0\.[A-Za-z0-9_-]{16}"$/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(validate('entitlements', body).ok).toBe(true);
    expect(validate('api/Entitlements', body).ok).toBe(true);
    await t.app.close();
  });

  it.each(['owner', 'admin', 'member', 'billing'] as const)('%s: 200', async (role) => {
    const t = await setup();
    const user = role === 'owner' ? t.owner : newId('usr');
    if (role !== 'owner') t.store.join(t.id, user, role);
    expect((await t.app.inject({ url: url(t.id), headers: asUser(user) })).statusCode).toBe(200);
    await t.app.close();
  });

  it('a guest gets 403', async () => {
    const t = await setup();
    const guest = newId('usr');
    t.store.join(t.id, guest, 'guest' as WorkspaceRole);
    const res = await t.app.inject({ url: url(t.id), headers: asUser(guest) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    await t.app.close();
  });

  it('a non-member, an unknown or malformed id, and a deleted workspace get 404', async () => {
    const t = await setup();
    const stranger = t.store.addUser();
    for (const [id, user] of [
      [t.id, stranger],
      [newId('wsp'), t.owner],
      ['not-an-id', t.owner],
    ] as const) {
      const res = await t.app.inject({ url: url(id), headers: asUser(user) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${t.id}`,
      headers: asUser(t.owner),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await t.app.inject({ url: url(t.id), headers: asUser(t.owner) })).statusCode).toBe(404);
    await t.app.close();
  });

  it('needs authentication and workspaces:read', async () => {
    const t = await setup();
    expect((await t.app.inject({ url: url(t.id) })).statusCode).toBe(401);
    const res = await t.app.inject({ url: url(t.id), headers: asUser(t.owner, 'profile') });
    expect(res.statusCode).toBe(403);
    await t.app.close();
  });

  it("an API key reads its own workspace's, not another's", async () => {
    const t = await setup();
    expect(
      (await t.app.inject({ url: url(t.id), headers: asKey(t.id, 'workspaces:read') })).statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ url: url(t.id), headers: asKey(newId('wsp'), 'workspaces:read') }))
        .statusCode,
    ).toBe(404);
    await t.app.close();
  });

  it('If-None-Match with the ETag gives 304; a change gives a new ETag', async () => {
    const t = await setup();
    const first = await t.app.inject({ url: url(t.id), headers: asUser(t.owner) });
    const etag = String(first.headers['etag']);
    for (const header of [etag, `W/${etag}`, `"x", ${etag}`, '*']) {
      const res = await t.app.inject({
        url: url(t.id),
        headers: { ...asUser(t.owner), 'if-none-match': header },
      });
      expect(res.statusCode).toBe(304);
      expect(res.body).toBe('');
      expect(res.headers['etag']).toBe(etag);
    }
    await t.entitlements.applySubscriptionState(t.id, {
      plan: 'team',
      status: 'active',
      period: { start: new Date(t.clock.now - 1000), end: new Date(t.clock.now + 30 * 86_400_000) },
      past_due_since: null,
      addon_seats: 3,
    });
    const changed = await t.app.inject({
      url: url(t.id),
      headers: { ...asUser(t.owner), 'if-none-match': etag },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ rev: 1, plan: 'team', limits: { max_seats: 8 } });
    expect(changed.headers['etag']).not.toBe(etag);
    expect(changed.headers['etag']).toMatch(/^"e1\./);
    expect(t.publisher.payloads()).toEqual([{ workspace: t.id, rev: 1 }]);
    await t.app.close();
  });

  it('usage that moves without a new rev changes the ETag', async () => {
    let minutes = 100;
    const t = await entitlementsApp({
      usage: {
        read: () => Promise.resolve({ usage: { hosted_minutes_month: minutes }, warnings: [] }),
      },
    });
    const owner = t.store.addUser();
    const { id } = await createWorkspace(t.app, owner);
    const first = await t.app.inject({ url: url(id), headers: asUser(owner) });
    minutes = 200;
    const second = await t.app.inject({
      url: url(id),
      headers: { ...asUser(owner), 'if-none-match': String(first.headers['etag']) },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ rev: 0, usage: { hosted_minutes_month: 200 } });
    await t.app.close();
  });
});
