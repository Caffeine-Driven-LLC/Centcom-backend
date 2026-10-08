/**
 * The portal and who may check out (B071 acceptance 5 and 7, guardrail "no entitlement on
 * checkout"): a workspace without a Stripe customer gets 404 from the portal and no customer is
 * created; with one it gets `{url}` returning to the configured billing page. A checkout answers
 * 201 `{url, expires_at}` (`expires_at` left out when Stripe gives none), `no-store`. A
 * subscription in effect (active, trialing, past due) refuses checkout with 409 and points to the
 * portal, with no Retry-After (B024's in-flight 409 has one); past due may still open the portal;
 * a canceled one may check out again. Creating a checkout changes no subscription and grants
 * nothing. Stripe being down is 503 with `retry_after_s`; Stripe refusing (a 4xx) is 502 with a
 * generic detail, counted and logged, never Stripe's message.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { buildRedirects } from '../../../src/modules/billing/checkout/redirects.js';
import {
  CHECKOUT_DETAILS,
  CHECKOUT_METRICS,
} from '../../../src/modules/billing/checkout/service.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import type { SubscriptionRow } from '../../../src/modules/billing/subscriptions/repository.js';
import { BILLING_DETAILS } from '../../../src/modules/billing/subscriptions/service.js';
import { caller, checkoutApp, newId, stripeId, teamCheckout } from './helpers.js';

/** A stored subscription of `ws` in `status`. */
const row = (ws: string, status: SubscriptionRow['status']): SubscriptionRow => ({
  id: newId('sub'),
  workspaceId: ws,
  stripeSubscriptionId: stripeId('sub'),
  plan: 'team',
  status,
  interval: 'month',
  currency: 'EUR',
  periodStart: new Date(Date.UTC(2026, 9, 1)),
  periodEnd: new Date(Date.UTC(2026, 10, 1)),
  seats: 5,
  cancelAtPeriodEnd: false,
  pastDueSince: status === 'past_due' ? new Date(Date.UTC(2026, 9, 5)) : null,
  updatedAt: new Date(Date.UTC(2026, 9, 5)),
  stripeEventCreated: 1,
});

describe('the portal', () => {
  it('is 404 without a Stripe customer, and creates none', async () => {
    const { app, owner, ws, stripe, billing } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'not_found',
      detail: CHECKOUT_DETAILS.noCustomer,
    });
    expect(stripe.creates).toEqual([]);
    expect(stripe.portals).toEqual([]);
    expect(billing.customers.has(ws)).toBe(false);
    await app.close();
  });

  it('opens a session for the existing customer, returning to the billing page', async () => {
    const { app, owner, ws, stripe, billing } = await checkoutApp();
    const customer = stripeId('cus');
    billing.customers.set(ws, customer);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(['url']);
    expect(validate('api/UrlResponse', body).ok).toBe(true);
    expect(stripe.portals).toEqual([
      { customerId: customer, returnUrl: buildRedirects('portal_return') },
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});

describe('the checkout answer', () => {
  it('is 201 {url, expires_at}: the session Stripe made, its expiry in ISO 8601, no-store', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(201);
    expect(stripe.sessions.size).toBe(1);
    const [session] = stripe.sessions.values();
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({ url: session?.url, expires_at: '2026-10-09T12:00:00.000Z' });
    expect(validate('api/UrlResponse', body).ok).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('leaves expires_at out when Stripe gives none', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    stripe.expiresAt = undefined;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(['url']);
    expect(validate('api/UrlResponse', body).ok).toBe(true);
    await app.close();
  });
});

describe('a subscription in effect', () => {
  it.each(['active', 'trialing', 'past_due'] as const)(
    'refuses checkout when the subscription is %s (409, to the portal)',
    async (status) => {
      const { app, owner, ws, stripe, billing } = await checkoutApp();
      billing.subscriptions.set(ws, row(ws, status));
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers: caller(owner),
        payload: teamCheckout(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string; detail: string }>()).toMatchObject({
        code: 'conflict',
        detail: CHECKOUT_DETAILS.alreadySubscribed,
      });
      // Go to the portal, not back: unlike B024's in-flight 409, no Retry-After.
      expect(res.headers['retry-after']).toBeUndefined();
      expect(stripe.checkouts).toEqual([]);
      await app.close();
    },
  );

  it('lets a past-due workspace reach the portal', async () => {
    const { app, owner, ws, billing } = await checkoutApp();
    billing.subscriptions.set(ws, row(ws, 'past_due'));
    billing.customers.set(ws, stripeId('cus'));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets a canceled workspace check out again', async () => {
    const { app, owner, ws, billing } = await checkoutApp();
    billing.subscriptions.set(ws, row(ws, 'canceled'));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('is not created by checkout: no subscription is stored, nothing is granted', async () => {
    const { app, owner, ws, billing } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ plan: 'pro', seats: 1 }),
    });
    expect(res.statusCode).toBe(201);
    expect(billing.subscriptions.size).toBe(0);
    await app.close();
  });
});

describe('Stripe failures', () => {
  it('answers 503 with retry_after_s when Stripe is unreachable, on both endpoints', async () => {
    const { app, owner, ws, stripe, billing, recorded } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    for (const path of ['checkout', 'portal']) {
      stripe.sessionFailures.push(new StripeError('unavailable', 'timeout'));
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/${path}`,
        headers: caller(owner),
        payload: path === 'checkout' ? teamCheckout() : {},
      });
      expect(res.statusCode, path).toBe(503);
      expect(res.json<{ retry_after_s: number; detail: string }>()).toMatchObject({
        retry_after_s: 30,
        detail: BILLING_DETAILS.stripeUnavailable,
      });
      expect(res.headers['retry-after']).toBe('30');
    }
    expect(
      recorded.count(CHECKOUT_METRICS.failures, { kind: 'portal', reason: 'stripe_unavailable' }),
    ).toBe(1);
    await app.close();
  });

  it('answers 502 with a generic detail when Stripe refuses, counts it and logs an error without Stripe’s message', async () => {
    const { app, owner, ws, stripe, captured, recorded } = await checkoutApp();
    stripe.sessionFailures.push(
      new StripeError('request', 'No such price: price_secret_detail', 400, 'resource_missing'),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(502);
    const problem = res.json<{ code: string; detail: string }>();
    expect(problem).toMatchObject({ code: 'bad_gateway', detail: BILLING_DETAILS.stripeRefused });
    expect(res.body).not.toContain('price_secret_detail');
    expect(
      recorded.count(CHECKOUT_METRICS.failures, { kind: 'checkout', reason: 'stripe_refused' }),
    ).toBe(1);
    const failed = captured.lines().find((l) => l['msg'] === 'billing.session_failed');
    expect(failed).toMatchObject({
      level: 'error',
      kind: 'checkout',
      stripe_kind: 'request',
      status: 400,
      stripe_code: 'resource_missing',
    });
    expect(captured.raw()).not.toContain('price_secret_detail');
    await app.close();
  });
});
