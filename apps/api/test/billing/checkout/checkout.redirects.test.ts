/**
 * Redirects come from configuration only (B071 acceptance 3, guardrail "MUST NOT accept redirect
 * URLs from the client"): a body carrying `success_url`, `cancel_url` or `return_url` is served as
 * if they were absent (never forwarded, never refused), and the recorded Stripe calls use exactly
 * the configured billing page (CT-DEEPLINK "Upgrade / billing"): `?checkout=success`,
 * `?checkout=cancel`, and the plain page for the portal's return, on WEB_BASE_URL.
 */
import { buildBillingUrl } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  appRedirect,
  buildRedirects,
  REDIRECT_QUERY,
} from '../../../src/modules/billing/checkout/redirects.js';
import { caller, checkoutApp, stripeId, teamCheckout } from './helpers.js';

const EVIL = 'https://evil.example/phish';

describe('redirect URLs', () => {
  it('are the configured billing page: success, cancel and portal return', () => {
    expect(buildRedirects('checkout_success')).toBe('https://centcom.dev/billing?checkout=success');
    expect(buildRedirects('checkout_cancel')).toBe('https://centcom.dev/billing?checkout=cancel');
    expect(buildRedirects('portal_return')).toBe('https://centcom.dev/billing');
    expect(buildRedirects('checkout_success', 'https://staging.centcom.dev')).toBe(
      'https://staging.centcom.dev/billing?checkout=success',
    );
    expect(buildRedirects('portal_return')).toBe(buildBillingUrl().web);
  });

  it('have app deep-link variants for the page to hand over to', () => {
    expect(appRedirect('checkout_success')).toBe('centcom://billing?checkout=success');
    expect(appRedirect('portal_return')).toBe('centcom://billing');
    expect(Object.keys(REDIRECT_QUERY).sort()).toEqual([
      'checkout_cancel',
      'checkout_success',
      'portal_return',
    ]);
  });
});

describe('redirects on the endpoints', () => {
  it('ignores success_url and cancel_url in a checkout body; Stripe gets the configured URLs', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ success_url: EVIL, cancel_url: EVIL, return_url: EVIL }),
    });
    expect(res.statusCode).toBe(201);
    const [call] = stripe.checkouts;
    expect(call?.input.successUrl).toBe(buildRedirects('checkout_success'));
    expect(call?.input.cancelUrl).toBe(buildRedirects('checkout_cancel'));
    expect(JSON.stringify(stripe.checkouts)).not.toContain('evil.example');
    await app.close();
  });

  it('does not even refuse a malformed redirect field: it is never read', async () => {
    const { app, owner, ws } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ success_url: 'not a url', cancel_url: 42 }),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('ignores return_url in a portal body; Stripe gets the configured billing page', async () => {
    const { app, owner, ws, billing, stripe } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: { return_url: EVIL },
    });
    expect(res.statusCode).toBe(200);
    expect(stripe.portals).toEqual([
      { customerId: billing.customers.get(ws), returnUrl: buildRedirects('portal_return') },
    ]);
    await app.close();
  });

  it('uses the redirects it is configured with', async () => {
    const { app, owner, ws, stripe } = await checkoutApp({
      redirects: (kind) => buildRedirects(kind, 'https://eu.centcom.dev'),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ success_url: EVIL }),
    });
    expect(stripe.checkouts[0]?.input.successUrl).toBe(
      'https://eu.centcom.dev/billing?checkout=success',
    );
    await app.close();
  });
});
