/**
 * The Stripe calls themselves (B071 acceptance 6): through B070's `StripeClient` over HTTP, against
 * a local Stripe stand-in that records every request, a checkout is a subscription-mode Checkout
 * Session for the customer `ensureCustomer` returned, with `client_reference_id` and
 * `metadata.workspace_id` (also on the subscription) set to the workspace, automatic tax on, the
 * catalogue's prices as line items, the configured return URLs and the derived Idempotency-Key;
 * Stripe's `expires_at` comes back as an ISO time. A portal session names the customer and the
 * billing page. A 4xx from Stripe is 502, a 5xx (after the client's retries) 503.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAppError, Secret } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRedirects } from '../../../src/modules/billing/checkout/redirects.js';
import { CheckoutService } from '../../../src/modules/billing/checkout/service.js';
import {
  STRIPE_API_VERSION_DEFAULT,
  StripeClient,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import {
  catalog,
  contact,
  memoryBilling,
  newId,
  stripeId,
  testSecretKey,
} from '../subscriptions/helpers.js';
import { sessionUrl } from './helpers.js';

type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Answer = { status: number; body?: unknown };

let server: Server;
let base = '';
const recorded: Recorded[] = [];
let script: Answer[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = script.shift() ?? { status: 500 };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body === undefined ? '{}' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The service over a StripeClient on the stand-in, for a workspace whose customer exists. */
function setup() {
  recorded.length = 0;
  script = [];
  const client = new StripeClient({
    config: {
      secretKey: new Secret(testSecretKey()),
      apiVersion: STRIPE_API_VERSION_DEFAULT,
      webhookSecret: null,
      apiBase: base,
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    clock: () => Date.UTC(2026, 9, 8, 12, 0, 0),
  });
  const ws = newId('wsp');
  const customer = stripeId('cus');
  const billing = memoryBilling({ [ws]: contact() });
  billing.customers.set(ws, customer);
  const service = new CheckoutService({
    gateway: client,
    billing: new BillingService({
      repository: billing.repository,
      gateway: client,
      catalog: catalog(),
    }),
    repository: billing.repository,
    catalog: catalog(),
    config: { maxSeats: 500 },
  });
  const actor = { kind: 'user' as const, userId: newId('usr'), scopes: ['billing:write'] };
  return { service, ws, customer, actor };
}

const form = (body: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(body).entries());

describe('the Stripe Checkout Session', () => {
  it('is a subscription for the customer with client_reference_id, metadata, automatic tax, catalogue prices and the configured URLs', async () => {
    const { service, ws, customer, actor } = setup();
    const url = sessionUrl();
    const expires = Math.floor(Date.UTC(2026, 9, 9, 12, 0, 0) / 1000);
    script = [{ status: 200, body: { id: stripeId('cs'), url, expires_at: expires } }];
    const key = crypto.randomUUID();
    const result = await service.createCheckout(
      ws,
      actor,
      { plan: 'team', interval: 'year', currency: 'USD', seats: 9 },
      key,
    );
    expect(result).toEqual({ url, expiresAt: new Date(expires * 1000).toISOString() });
    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/checkout/sessions');
    expect(call?.headers['idempotency-key']).toMatch(
      new RegExp(`^centcom-${ws}-checkout-[0-9a-f]{32}$`),
    );
    expect(form(call?.body ?? '')).toMatchObject({
      mode: 'subscription',
      customer,
      client_reference_id: ws,
      'metadata[workspace_id]': ws,
      'subscription_data[metadata][workspace_id]': ws,
      'automatic_tax[enabled]': 'true',
      'line_items[0][price]': 'price_teamyearUSD',
      'line_items[0][quantity]': '1',
      'line_items[1][price]': 'price_seatyearUSD',
      'line_items[1][quantity]': '4',
      success_url: buildRedirects('checkout_success'),
      cancel_url: buildRedirects('checkout_cancel'),
    });
  });

  it('leaves expires_at out when Stripe gives none', async () => {
    const { service, ws, actor } = setup();
    script = [{ status: 200, body: { url: sessionUrl() } }];
    const result = await service.createCheckout(
      ws,
      actor,
      { plan: 'pro', interval: 'month', currency: 'EUR' },
      crypto.randomUUID(),
    );
    expect(result.expiresAt).toBeNull();
    expect(form(recorded[0]?.body ?? '')['line_items[1][price]']).toBeUndefined();
  });

  it('is 502 when Stripe refuses (4xx) and 503 when it keeps failing (5xx)', async () => {
    const { service, ws, actor } = setup();
    script = [
      { status: 400, body: { error: { code: 'resource_missing', message: 'No such price' } } },
    ];
    const refused = await service
      .createCheckout(
        ws,
        actor,
        { plan: 'pro', interval: 'month', currency: 'EUR' },
        crypto.randomUUID(),
      )
      .catch((e: unknown) => e);
    expect(isAppError(refused) && refused.code === 'bad_gateway' && refused.status === 502).toBe(
      true,
    );
    script = Array.from({ length: 4 }, () => ({ status: 503 }));
    const down = await service
      .createCheckout(
        ws,
        actor,
        { plan: 'pro', interval: 'month', currency: 'EUR' },
        crypto.randomUUID(),
      )
      .catch((e: unknown) => e);
    expect(isAppError(down) && down.code === 'service_unavailable' && down.retryAfterS === 30).toBe(
      true,
    );
  });
});

describe('the Stripe billing portal session', () => {
  it('names the customer and returns to the billing page', async () => {
    const { service, ws, customer, actor } = setup();
    const url = sessionUrl('billing.stripe.com');
    script = [{ status: 200, body: { url } }];
    expect(await service.createPortal(ws, actor)).toEqual({ url });
    expect(recorded[0]?.url).toBe('/v1/billing_portal/sessions');
    expect(form(recorded[0]?.body ?? '')).toEqual({
      customer,
      return_url: buildRedirects('portal_return'),
    });
  });
});
