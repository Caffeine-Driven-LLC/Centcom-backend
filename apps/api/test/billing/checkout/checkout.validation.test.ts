/**
 * What checkout sells (B071 acceptance 4, guardrail "plan, price and currency from the server
 * catalogue"): plan `free`, interval `week`, currency `GBP`, team seats below 5 or above
 * BILLING_MAX_SEATS (default 500), and pro seats other than 1 are 422 with `errors[].pointer`;
 * every problem is listed at once; the price ids come from the catalogue only (USD when no
 * currency is given; team seats above 5 as add-on seats at the seat price); a plan the catalogue
 * does not price is 422 too. A body that is not an object is 422.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SEATS,
  loadCheckoutConfig,
} from '../../../src/modules/billing/checkout/service.js';
import { loadPriceCatalog, priceKey } from '../../../src/modules/billing/stripe/price-catalog.js';
import { catalogEnv } from '../subscriptions/helpers.js';
import { caller, checkoutApp, teamCheckout } from './helpers.js';

type Problem = { status: number; code: string; errors?: { pointer: string; code: string }[] };

async function refused(
  payload: unknown,
  options: Parameters<typeof checkoutApp>[0] = {},
): Promise<Problem> {
  const { app, owner, ws, stripe } = await checkoutApp(options);
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${ws}/checkout`,
    headers: caller(owner),
    payload: payload as Record<string, unknown>,
  });
  expect(stripe.checkouts).toEqual([]);
  await app.close();
  return res.json<Problem>();
}

const pointers = (p: Problem): string[] => (p.errors ?? []).map((e) => e.pointer).sort();

describe('checkout validation', () => {
  it.each([
    ['plan free', teamCheckout({ plan: 'free' }), '/plan'],
    ['interval week', teamCheckout({ interval: 'week' }), '/interval'],
    ['currency GBP', teamCheckout({ currency: 'GBP' }), '/currency'],
    ['team seats below 5', teamCheckout({ seats: 4 }), '/seats'],
    ['team seats above 500', teamCheckout({ seats: 501 }), '/seats'],
    ['pro with 2 seats', { plan: 'pro', interval: 'month', seats: 2 }, '/seats'],
    ['seats 0', teamCheckout({ seats: 0 }), '/seats'],
    ['seats not a number', teamCheckout({ seats: 'ten' }), '/seats'],
    ['no plan', { interval: 'month' }, '/plan'],
  ])('refuses %s with 422 at its pointer', async (_name, payload, pointer) => {
    const problem = await refused(payload);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe('validation_failed');
    expect(pointers(problem)).toContain(pointer);
  });

  it('lists every bad field at once', async () => {
    const problem = await refused({ plan: 'free', interval: 'week', currency: 'GBP' });
    expect(pointers(problem)).toEqual(['/currency', '/interval', '/plan']);
  });

  it('refuses a body that is not an object', async () => {
    const problem = await refused(['team']);
    expect(problem.status).toBe(422);
  });

  it('honours a configured seat maximum', async () => {
    expect((await refused(teamCheckout({ seats: 51 }), { config: { maxSeats: 50 } })).status).toBe(
      422,
    );
    const { app, owner, ws } = await checkoutApp({ config: { maxSeats: 50 } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ seats: 50 }),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('prices from the catalogue: USD by default, team seats above 5 as add-on seats', async () => {
    const { app, owner, ws, stripe } = await checkoutApp();
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers: caller(owner),
        payload,
      });
    expect((await post({ plan: 'pro', interval: 'year' })).statusCode).toBe(201);
    expect((await post(teamCheckout({ seats: 12 }))).statusCode).toBe(201);
    expect((await post(teamCheckout({ seats: 5 }))).statusCode).toBe(201);
    const [pro, team12, team5] = stripe.checkouts.map((c) => c.input);
    expect(pro).toMatchObject({ priceId: 'price_proyearUSD' });
    expect(pro?.seats).toBeUndefined();
    expect(team12).toMatchObject({
      priceId: 'price_teammonthEUR',
      seats: { priceId: 'price_seatmonthEUR', quantity: 7 },
    });
    expect(team5?.seats).toBeUndefined();
    await app.close();
  });

  it('refuses a plan or seats the catalogue does not price (422), never a client price', async () => {
    const unpriced = new Set([priceKey('team', 'year', 'USD'), priceKey('seat', 'month', 'USD')]);
    const env = Object.fromEntries(
      Object.entries(catalogEnv()).filter(([key]) => !unpriced.has(key)),
    );
    const partial = loadPriceCatalog({ ...env, NODE_ENV: 'development' });
    const plan = await refused(teamCheckout({ interval: 'year', currency: 'USD' }), {
      catalog: partial,
    });
    expect(plan.status).toBe(422);
    expect(pointers(plan)).toEqual(['/plan']);
    const seats = await refused(teamCheckout({ currency: 'USD', seats: 8 }), { catalog: partial });
    expect(pointers(seats)).toEqual(['/seats']);
    // A price id in the body is not a field of the contract's request: it is never read.
    const { app, owner, ws, stripe } = await checkoutApp();
    await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ price: 'price_free_lunch', amount: 0 }),
    });
    expect(stripe.checkouts[0]?.input.priceId).toBe('price_teammonthEUR');
    await app.close();
  });
});

describe('BILLING_MAX_SEATS', () => {
  it('defaults to 500, reads the key, and refuses values below the 5 included seats', () => {
    expect(loadCheckoutConfig({})).toEqual({ maxSeats: DEFAULT_MAX_SEATS });
    expect(DEFAULT_MAX_SEATS).toBe(500);
    expect(loadCheckoutConfig({ BILLING_MAX_SEATS: '50' })).toEqual({ maxSeats: 50 });
    expect(() => loadCheckoutConfig({ BILLING_MAX_SEATS: '4' })).toThrow(ConfigError);
    expect(() => loadCheckoutConfig({ BILLING_MAX_SEATS: 'many' })).toThrow(ConfigError);
  });
});
