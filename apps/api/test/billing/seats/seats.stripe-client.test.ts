/**
 * B070's `StripeClient.previewInvoice` as seat previews use it (B073 guardrail "Money MUST be
 * integer minor units ... (use Stripe's values)"): `POST /v1/invoices/create_preview` for the
 * customer and subscription with the item change, `proration_behavior: create_prorations` and the
 * `proration_date` asked for; the answer's lines keep Stripe's amounts, whether each is a
 * proration (either API version's marker) and when its period starts.
 */
import { Secret } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  STRIPE_API_VERSION_DEFAULT,
  StripeClient,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { testSecretKey } from '../subscriptions/helpers.js';
import { stripeId } from './helpers.js';

/** A client whose fetch answers `body` once and records the request. */
function stubbed(body: unknown) {
  const requests: { url: URL; method: string; form: URLSearchParams }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
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

describe('StripeClient.previewInvoice', () => {
  it('asks for the change prorated from the given instant, and keeps each line’s start', async () => {
    const at = Date.UTC(2026, 9, 9, 12) / 1000;
    const { client, requests } = stubbed({
      object: 'invoice',
      currency: 'eur',
      amount_due: 9100,
      next_payment_attempt: null,
      lines: {
        data: [
          { amount: -400, proration: true, period: { start: at - 86_400, end: at + 86_400 } },
          {
            amount: 1200,
            parent: { subscription_item_details: { proration: true } },
            period: { start: at, end: at + 86_400 },
          },
          { amount: 7900, proration: false, period: { start: at + 86_400 } },
          { amount: 100 },
        ],
      },
    });
    const customerId = stripeId('cus');
    const subscriptionId = stripeId('sub');
    const itemId = stripeId('si');
    const preview = await client.previewInvoice({
      customerId,
      subscriptionId,
      items: [{ id: itemId, priceId: 'price_seatmonthEUR', quantity: 3 }],
      prorationDate: at,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url.pathname).toBe('/v1/invoices/create_preview');
    const form = requests[0]?.form;
    expect(form?.get('customer')).toBe(customerId);
    expect(form?.get('subscription')).toBe(subscriptionId);
    expect(form?.get('subscription_details[items][0][id]')).toBe(itemId);
    expect(form?.get('subscription_details[items][0][quantity]')).toBe('3');
    expect(form?.get('subscription_details[proration_behavior]')).toBe('create_prorations');
    expect(form?.get('subscription_details[proration_date]')).toBe(String(at));
    expect(preview).toEqual({
      currency: 'EUR',
      amountDue: 9100,
      nextPaymentAttempt: null,
      lines: [
        { amount: -400, proration: true, periodStart: at - 86_400 },
        { amount: 1200, proration: true, periodStart: at },
        { amount: 7900, proration: false, periodStart: at + 86_400 },
        { amount: 100, proration: false },
      ],
    });
  });

  it('leaves proration_date to Stripe when none is given', async () => {
    const { client, requests } = stubbed({ currency: 'usd', amount_due: 0, lines: { data: [] } });
    await client.previewInvoice({
      customerId: stripeId('cus'),
      subscriptionId: stripeId('sub'),
      items: [{ priceId: 'price_seatmonthUSD', quantity: 1 }],
    });
    expect(requests[0]?.form.has('subscription_details[proration_date]')).toBe(false);
    expect(requests[0]?.form.get('subscription_details[items][0][price]')).toBe(
      'price_seatmonthUSD',
    );
  });
});
