/**
 * B070's `StripeClient` reading invoices for the mirror (B077 build_against: a Stripe stub
 * intercepting HTTP through the provider abstraction; failure path "Stripe 429/5xx during lazy
 * sync"):
 *
 * - `listInvoices` asks `GET /v1/invoices` for one customer's newest invoices (`customer`,
 *   `limit`, `starting_after`), with the secret key and the pinned `Stripe-Version`, and hands
 *   the objects back as Stripe sent them, with `has_more`;
 * - `retrieveInvoice` asks `GET /v1/invoices/{id}`;
 * - 429 and 5xx are retried with backoff and then fail as `unavailable` (which the lazy sync logs
 *   and counts while the list answers from the mirror); other 4xx fail at once;
 * - ids and limits are checked before anything is sent; an answer that is not a list is
 *   `invalid_response`.
 */
import { Secret } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import {
  STRIPE_API_VERSION_DEFAULT,
  STRIPE_RETRIES,
  StripeClient,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { testSecretKey } from '../subscriptions/helpers.js';
import { fixture, stripeId } from './helpers.js';

type Answer = { status: number; body?: unknown };

/** A client whose fetch answers from `script` and records each request. */
function stubbed(script: Answer[]) {
  const requests: { url: URL; method: string; headers: Headers }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    const answer = script.shift() ?? { status: 500 };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const client = new StripeClient({
    config: {
      secretKey: new Secret(testSecretKey()),
      apiVersion: STRIPE_API_VERSION_DEFAULT,
      webhookSecret: null,
      apiBase: 'https://stripe.test',
    },
    fetch: fetchStub,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { client, requests };
}

describe('StripeClient: invoices', () => {
  it("lists a customer's newest invoices, as Stripe sent them", async () => {
    const customer = stripeId('cus');
    const invoices = [fixture('open-eur-vat'), fixture('paid-usd-tax')];
    const { client, requests } = stubbed([
      { status: 200, body: { object: 'list', data: invoices, has_more: true } },
    ]);
    const after = stripeId('in');
    const page = await client.listInvoices(customer, { limit: 100, startingAfter: after });
    expect(page).toEqual({ data: invoices, hasMore: true });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('GET');
    expect(request?.url.pathname).toBe('/v1/invoices');
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      customer,
      limit: '100',
      starting_after: after,
    });
    expect(request?.headers.get('authorization')).toBe(`Bearer ${testSecretKey()}`);
    expect(request?.headers.get('stripe-version')).toBe(STRIPE_API_VERSION_DEFAULT);
    expect(request?.headers.get('idempotency-key')).toBeNull();
  });

  it('reads has_more as false unless Stripe says true, and the first page without a cursor', async () => {
    const { client, requests } = stubbed([{ status: 200, body: { data: [] } }]);
    expect(await client.listInvoices(stripeId('cus'), { limit: 1 })).toEqual({
      data: [],
      hasMore: false,
    });
    expect(requests[0]?.url.searchParams.has('starting_after')).toBe(false);
  });

  it('retrieves one invoice', async () => {
    const invoice = fixture('draft-eur');
    const { client, requests } = stubbed([{ status: 200, body: invoice }]);
    const id = stripeId('in');
    expect(await client.retrieveInvoice(id)).toEqual(invoice);
    expect(requests[0]?.url.pathname).toBe(`/v1/invoices/${id}`);
  });

  it('retries 429 and 5xx, then fails as unavailable; other 4xx fail at once', async () => {
    const busy = stubbed([{ status: 429 }, { status: 503 }, { status: 500 }, { status: 429 }]);
    const error = await busy.client
      .listInvoices(stripeId('cus'), { limit: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect((error as StripeError).kind).toBe('unavailable');
    expect(busy.requests).toHaveLength(STRIPE_RETRIES + 1);

    const recovered = stubbed([{ status: 503 }, { status: 200, body: { data: [] } }]);
    await expect(recovered.client.listInvoices(stripeId('cus'), { limit: 10 })).resolves.toEqual({
      data: [],
      hasMore: false,
    });

    const refused = stubbed([{ status: 404, body: { error: { code: 'resource_missing' } } }]);
    const missing = await refused.client.retrieveInvoice(stripeId('in')).catch((e: unknown) => e);
    expect((missing as StripeError).kind).toBe('request');
    expect((missing as StripeError).stripeCode).toBe('resource_missing');
    expect(refused.requests).toHaveLength(1);
  });

  it('checks ids and limits before sending, and refuses an answer that is not a list', async () => {
    const { client, requests } = stubbed([{ status: 200, body: { data: 'nope' } }]);
    for (const call of [
      () => client.listInvoices('wsp_x', { limit: 10 }),
      () => client.listInvoices(stripeId('cus'), { limit: 0 }),
      () => client.listInvoices(stripeId('cus'), { limit: 101 }),
      () => client.listInvoices(stripeId('cus'), { limit: 1.5 }),
      () => client.listInvoices(stripeId('cus'), { limit: 1, startingAfter: '../x' }),
      () => client.retrieveInvoice('../../v1/customers'),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect((error as StripeError).kind).toBe('request');
    }
    expect(requests).toHaveLength(0);
    const bad = await client.listInvoices(stripeId('cus'), { limit: 1 }).catch((e: unknown) => e);
    expect((bad as StripeError).kind).toBe('invalid_response');
  });
});
