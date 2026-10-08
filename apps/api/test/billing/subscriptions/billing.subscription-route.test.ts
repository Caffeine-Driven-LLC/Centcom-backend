/**
 * `GET /v1/workspaces/{id}/subscription` (B070 acceptance 3 and 4, guardrails, failure mode
 * "Stripe unavailable"): owner, billing and admin get 200, member and guest 403, a non-member
 * 404, all by roles from the membership store (B021), never a claim; an API key needs
 * `billing:read` and its own workspace; a token without `billing:read` is 403. The body validates
 * as `api/Subscription` and holds only its keys: no Stripe id, card detail or e-mail. A workspace
 * without a subscription in effect is 404 `not_found`. The route never calls Stripe, so it works
 * while Stripe is down.
 */
import { validate } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { asKey, asUser, createWorkspace } from '../../modules/workspaces/helpers.js';
import { newId, stripeId, stripeSub, subscriptionApp } from './helpers.js';

const READ = 'billing:read';
const SUBSCRIPTION_KEYS = [
  'cancel_at_period_end',
  'current_period_end',
  'current_period_start',
  'currency',
  'grace_until',
  'id',
  'interval',
  'plan',
  'seats',
  'status',
  'trial_end',
  'workspace',
];

async function withSubscription() {
  const ctx = await subscriptionApp();
  const owner = newId('usr');
  ctx.store.addUser(owner);
  const ws = (await createWorkspace(ctx.app, owner)).id;
  const customer = stripeId('cus');
  ctx.billing.customers.set(ws, customer);
  const sub = stripeSub(customer, { addonSeats: 3 });
  await ctx.service.upsertFromStripe(sub, 100);
  return { ...ctx, owner, ws, customer, sub };
}

describe('GET /v1/workspaces/{id}/subscription', () => {
  it('answers owner, billing and admin; refuses member and guest with 403 and outsiders with 404', async () => {
    const { app, store, owner, ws } = await withSubscription();
    const get = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/v1/workspaces/${ws}/subscription`, headers });
    expect((await get(asUser(owner, READ))).statusCode).toBe(200);
    const expected: [WorkspaceRole, number][] = [
      ['admin', 200],
      ['billing', 200],
      ['member', 403],
      ['guest', 403],
    ];
    for (const [role, status] of expected) {
      const user = newId('usr');
      store.join(ws, user, role);
      expect((await get(asUser(user, READ))).statusCode, role).toBe(status);
    }
    expect((await get(asUser(newId('usr'), READ))).statusCode).toBe(404);
    // A role claim in the request changes nothing: the store decides.
    const member = newId('usr');
    store.join(ws, member, 'member');
    expect((await get({ ...asUser(member, READ), 'x-test-role': 'owner' })).statusCode).toBe(403);
    await app.close();
  });

  it('needs billing:read, and an API key of the workspace itself', async () => {
    const { app, owner, ws } = await withSubscription();
    const url = `/v1/workspaces/${ws}/subscription`;
    expect(
      (await app.inject({ method: 'GET', url, headers: asUser(owner, 'workspaces:read') }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: asKey(ws, READ) })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ method: 'GET', url, headers: asKey(ws, 'workspaces:read') })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url, headers: asKey(newId('wsp'), READ) })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    await app.close();
  });

  it('answers a Subscription with its keys only: no Stripe ids, card data or e-mail', async () => {
    const { app, owner, ws, customer, sub } = await withSubscription();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/subscription`,
      headers: asUser(owner, READ),
    });
    const body = response.json<Record<string, unknown>>();
    expect(validate('api/Subscription', body).ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...SUBSCRIPTION_KEYS].sort());
    expect(body).toMatchObject({
      workspace: ws,
      plan: 'team',
      status: 'active',
      seats: 8,
      interval: 'month',
      currency: 'EUR',
      current_period_start: '2026-10-01T00:00:00.000Z',
      current_period_end: '2026-11-01T00:00:00.000Z',
      cancel_at_period_end: false,
      trial_end: null,
      grace_until: null,
    });
    expect(String(body['id'])).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
    for (const secret of [
      customer,
      sub.id,
      ...sub.items.map((i) => i.id),
      ...sub.items.map((i) => i.priceId),
    ]) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.body).not.toMatch(/cus_|price_|si_|@|last4|brand/);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    await app.close();
  });

  it('answers 404 not_found for a workspace without a subscription in effect', async () => {
    const ctx = await subscriptionApp();
    const owner = newId('usr');
    ctx.store.addUser(owner);
    const ws = (await createWorkspace(ctx.app, owner)).id;
    const get = () =>
      ctx.app.inject({
        method: 'GET',
        url: `/v1/workspaces/${ws}/subscription`,
        headers: asUser(owner, READ),
      });
    const none = await get();
    expect(none.statusCode).toBe(404);
    expect(none.json<{ code: string }>().code).toBe('not_found');
    const customer = stripeId('cus');
    ctx.billing.customers.set(ws, customer);
    await ctx.service.upsertFromStripe(stripeSub(customer, { status: 'incomplete_expired' }), 1);
    expect((await get()).statusCode).toBe(404);
    await ctx.app.close();
  });

  it('keeps answering from the database while Stripe is down', async () => {
    const { app, owner, ws, stripe } = await withSubscription();
    stripe.retrieveSubscription = () => Promise.reject(new Error('stripe down'));
    stripe.findCustomerByWorkspace = () => Promise.reject(new Error('stripe down'));
    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${ws}/subscription`,
      headers: asUser(owner, READ),
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
