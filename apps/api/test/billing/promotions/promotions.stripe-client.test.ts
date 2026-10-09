/**
 * B070's `StripeClient` for promotions (B079 build_against: the Stripe provider abstraction with
 * promotion-code lookup and subscription update):
 *
 * - `findPromotionCodes` asks `GET /v1/promotion_codes` for the active codes with that text
 *   (Stripe matches it case-insensitively; one per customer restriction), at most 10, the
 *   coupons' `applies_to` and `currency_options` expanded; a code Stripe could not hold is not
 *   sent at all;
 * - `retrievePromotionCode` asks `GET /v1/promotion_codes/{id}`, the same expanded;
 * - `subscriptionDiscounts` reads a subscription's discounts (expanded, with the promotion code
 *   each came from) and its items' products, ids or expanded objects;
 * - `applyPromotionCode` posts the kept discounts plus the promotion code
 *   (`discounts[i][discount]`, `discounts[n][promotion_code]`, API 2025-03-31.basil) with the
 *   caller's idempotency key, and parses the subscription Stripe returns;
 * - ids are checked before anything is sent, and 429/5xx are retried, then `unavailable`.
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
import { newCode, promotionCode, stripeId } from './helpers.js';

type Answer = { status: number; body?: unknown };

function stubbed(script: Answer[]) {
  const requests: { url: URL; method: string; headers: Headers; body: string }[] = [];
  const client = new StripeClient({
    config: {
      secretKey: new Secret(testSecretKey()),
      apiVersion: STRIPE_API_VERSION_DEFAULT,
      webhookSecret: null,
      apiBase: 'https://stripe.test',
    },
    fetch: (input, init) => {
      requests.push({
        url: new URL(String(input)),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const answer = script.shift() ?? { status: 500 };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body ?? {}), { status: answer.status }),
      );
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { client, requests };
}

const subscriptionJson = (id: string, customer: string) => ({
  object: 'subscription',
  id,
  customer,
  status: 'active',
  currency: 'eur',
  cancel_at_period_end: false,
  metadata: {},
  discounts: [
    { id: 'di_FixtureKept', object: 'discount', promotion_code: null },
    { id: 'di_FixturePromo', object: 'discount', promotion_code: 'promo_FixtureSpring' },
    { id: 'di_FixtureExpanded', object: 'discount', promotion_code: { id: 'promo_FixtureX' } },
    'di_FixtureBare',
  ],
  items: {
    object: 'list',
    data: [
      {
        id: stripeId('si'),
        price: { id: 'price_teammonthEUR', product: 'prod_FixtureTeam' },
        quantity: 1,
        current_period_start: 1_790_000_000,
        current_period_end: 1_792_592_000,
      },
      {
        id: stripeId('si'),
        price: { id: 'price_seatmonthEUR', product: { id: 'prod_FixtureSeat' } },
        quantity: 3,
      },
    ],
  },
});

describe('StripeClient: promotions', () => {
  it('finds the active promotion codes with a code, coupon details expanded', async () => {
    const code = newCode();
    const promo = promotionCode(code);
    const { client, requests } = stubbed([
      { status: 200, body: { object: 'list', data: [promo] } },
      { status: 200, body: { object: 'list', data: [] } },
    ]);
    expect(await client.findPromotionCodes(code)).toEqual([promo]);
    expect(await client.findPromotionCodes('NOPE')).toEqual([]);
    const [first] = requests;
    expect(first?.method).toBe('GET');
    expect(first?.url.pathname).toBe('/v1/promotion_codes');
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({
      code,
      active: 'true',
      limit: '10',
      'expand[0]': 'data.coupon.applies_to',
      'expand[1]': 'data.coupon.currency_options',
    });
    expect(first?.headers.get('stripe-version')).toBe(STRIPE_API_VERSION_DEFAULT);
    // A code Stripe could not hold is not sent.
    expect(await client.findPromotionCodes('CAFÉ')).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('retrieves a promotion code by id', async () => {
    const promo = promotionCode(newCode());
    const { client, requests } = stubbed([{ status: 200, body: promo }]);
    expect(await client.retrievePromotionCode(String(promo['id']))).toEqual(promo);
    expect(requests[0]?.url.pathname).toBe(`/v1/promotion_codes/${String(promo['id'])}`);
    expect(requests[0]?.url.searchParams.get('expand[0]')).toBe('coupon.applies_to');
    expect(requests[0]?.url.searchParams.get('expand[1]')).toBe('coupon.currency_options');
    const bad = await client.retrievePromotionCode('co_x').catch((e: unknown) => e);
    expect((bad as StripeError).kind).toBe('request');
    expect(requests).toHaveLength(1);
  });

  it("reads a subscription's discounts and products", async () => {
    const id = stripeId('sub');
    const { client, requests } = stubbed([
      { status: 200, body: subscriptionJson(id, stripeId('cus')) },
    ]);
    expect(await client.subscriptionDiscounts(id)).toEqual({
      discounts: [
        { id: 'di_FixtureKept', promotionCodeId: null },
        { id: 'di_FixturePromo', promotionCodeId: 'promo_FixtureSpring' },
        { id: 'di_FixtureExpanded', promotionCodeId: 'promo_FixtureX' },
        { id: 'di_FixtureBare', promotionCodeId: null },
      ],
      productIds: ['prod_FixtureTeam', 'prod_FixtureSeat'],
    });
    expect(requests[0]?.url.pathname).toBe(`/v1/subscriptions/${id}`);
    expect(requests[0]?.url.searchParams.get('expand[0]')).toBe('discounts');
  });

  it('applies a promotion code keeping the other discounts, with the idempotency key', async () => {
    const id = stripeId('sub');
    const customer = stripeId('cus');
    const promo = stripeId('promo');
    const { client, requests } = stubbed([{ status: 200, body: subscriptionJson(id, customer) }]);
    const sub = await client.applyPromotionCode(
      { subscriptionId: id, promotionCodeId: promo, keepDiscountIds: ['di_FixtureKept'] },
      'centcom-wsp-promo-x',
    );
    expect(sub).toMatchObject({ id, customerId: customer, status: 'active' });
    const [post] = requests;
    expect(post?.method).toBe('POST');
    expect(post?.url.pathname).toBe(`/v1/subscriptions/${id}`);
    expect(post?.headers.get('idempotency-key')).toBe('centcom-wsp-promo-x');
    expect(Object.fromEntries(new URLSearchParams(post?.body ?? ''))).toEqual({
      'discounts[0][discount]': 'di_FixtureKept',
      'discounts[1][promotion_code]': promo,
    });
  });

  it('checks ids first, and retries 429/5xx before failing as unavailable', async () => {
    const { client, requests } = stubbed([]);
    for (const call of [
      () => client.subscriptionDiscounts('cus_x'),
      () =>
        client.applyPromotionCode(
          { subscriptionId: '../x', promotionCodeId: 'promo_x', keepDiscountIds: [] },
          'k',
        ),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect((error as StripeError).kind).toBe('request');
    }
    expect(requests).toHaveLength(0);
    const busy = stubbed([{ status: 429 }, { status: 503 }, { status: 500 }, { status: 502 }]);
    const error = await busy.client.findPromotionCodes('SPRING').catch((e: unknown) => e);
    expect((error as StripeError).kind).toBe('unavailable');
    expect(busy.requests).toHaveLength(STRIPE_RETRIES + 1);
    const odd = stubbed([{ status: 200, body: { data: 'x' } }]);
    const invalid = await odd.client.findPromotionCodes('SPRING').catch((e: unknown) => e);
    expect((invalid as StripeError).kind).toBe('invalid_response');
  });
});
