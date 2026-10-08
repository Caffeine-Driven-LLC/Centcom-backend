/**
 * Idempotency of checkout (B071 acceptance 1, guardrail "deterministic Stripe idempotency key"):
 * no Idempotency-Key is 400 `idempotency_key_required`; the same key and body replay the
 * identical 201 with `Idempotency-Replayed: true` (still `Cache-Control: no-store`) and create
 * exactly one Stripe session; the same key with another body is 409 `idempotency_conflict`.
 * The key handed to Stripe is derived from the workspace, the caller, the client's key and the
 * request, so a retry after a 503 (which the middleware does not store) gets the same session,
 * while another caller's or another request's never does. The portal accepts a key and replays
 * it too.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { caller, checkoutApp, newId, stripeId, teamCheckout } from './helpers.js';

describe('checkout idempotency', () => {
  it('requires an Idempotency-Key: 400 idempotency_key_required, and Stripe is not called', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner, undefined, null),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('idempotency_key_required');
    expect(stripe.checkouts).toEqual([]);
    await app.close();
  });

  it('replays the same key and body: the identical body, Idempotency-Replayed: true, one Stripe session', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const headers = caller(owner);
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers,
        payload: teamCheckout(),
      });
    const first = await send();
    const second = await send();
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    // B024 stores only content headers; the route's hook keeps the replay out of caches too.
    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.headers['cache-control']).toBe('no-store');
    expect(stripe.checkouts).toHaveLength(1);
    await app.close();
  });

  it('refuses the same key with another body: 409 idempotency_conflict, no new session', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const headers = caller(owner);
    const send = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/checkout`, headers, payload });
    expect((await send(teamCheckout())).statusCode).toBe(201);
    const other = await send(teamCheckout({ seats: 9 }));
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
    expect(stripe.checkouts).toHaveLength(1);
    await app.close();
  });

  it('hands Stripe the same key when a 503 is retried with the same Idempotency-Key, so one session results', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    stripe.sessionFailures.push(new StripeError('unavailable', 'timeout'));
    const headers = caller(owner);
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers,
        payload: teamCheckout(),
      });
    const failed = await send();
    expect(failed.statusCode).toBe(503);
    expect(failed.json<{ retry_after_s: number }>().retry_after_s).toBeGreaterThan(0);
    const retried = await send();
    expect(retried.statusCode).toBe(201);
    expect(stripe.checkouts).toHaveLength(2);
    const [a, b] = stripe.checkouts;
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toMatch(new RegExp(`^centcom-${ws}-checkout-[0-9a-f]{32}$`));
    // The customer created on the first try is reused (B070).
    expect(stripe.creates).toHaveLength(1);
    expect(a?.input.customerId).toBe(b?.input.customerId);
    await app.close();
  });

  it('gives another caller, another client key or another request its own Stripe key', async () => {
    const { app, store, owner, ws, stripe } = await checkoutApp();
    const billingMember = newId('usr');
    store.join(ws, billingMember, 'billing');
    const key = randomUUID();
    const send = (user: string, k: string, payload = teamCheckout()) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers: caller(user, undefined, k),
        payload,
      });
    await send(owner, key);
    await send(billingMember, key);
    await send(owner, randomUUID());
    await send(owner, randomUUID(), teamCheckout({ seats: 6 }));
    expect(new Set(stripe.checkouts.map((c) => c.key)).size).toBe(4);
    await app.close();
  });

  it('replays the portal for a repeated key and calls Stripe once', async () => {
    const { app, owner, ws, billing, stripe } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    const headers = caller(owner);
    const send = () =>
      app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/portal`, headers, payload: {} });
    const first = await send();
    const second = await send();
    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers['cache-control']).toBe('no-store');
    expect(stripe.portals).toHaveLength(1);
    // Without a key the portal still answers (the key is accepted, not required).
    const keyless = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner, undefined, null),
      payload: {},
    });
    expect(keyless.statusCode).toBe(200);
    await app.close();
  });
});
