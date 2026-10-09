/**
 * The invoice list on the wire (B077 test plan "contract: response headers include RateLimit-*
 * and X-Request-Id; errors are problem+json"; acceptance 3 and 5; guardrail "MUST NOT return or
 * log Stripe customer ids, payment method details, or raw Stripe objects"):
 *
 * - a 200 carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `X-Request-Id`
 *   (CT-PAGE, CT-API-BILLING `listInvoices`), and so do its errors, which are problem+json;
 * - the body validates as `api/InvoicePage`: amounts are integer minor units in USD or EUR;
 * - it never carries a customer id, a payment intent, a charge, a payment method, card details,
 *   the customer's name, address or e-mail, tax ids, or any other part of the Stripe objects;
 * - it is `private, no-store` (the hosted links open the invoice page), and its log lines hold
 *   none of that either.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_PATTERN } from '../../helpers.js';
import { asUser } from '../../modules/workspaces/helpers.js';
import { FIXTURES, fixture, listAs, newId, READ, withWorkspace } from './helpers.js';

const RATE_HEADERS = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'];

/** Every fixture, as an invoice of `customerId` (the GBP one is excluded by the mirror). */
const allFixtures = (customerId: string) =>
  FIXTURES.map((name) => ({ ...fixture(name), customer: customerId }));

describe('GET /v1/workspaces/{id}/invoices on the wire', () => {
  it('carries RateLimit-* and X-Request-Id, on success and on errors (problem+json)', async () => {
    const ctx = await withWorkspace({ rateLimit: true });
    const ok = await listAs(ctx, ctx.ws, ctx.owner);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^application\/json/);
    for (const header of RATE_HEADERS) expect(ok.headers[header], header).toBeDefined();
    expect(String(ok.headers['x-request-id'])).toMatch(REQUEST_ID_PATTERN);

    const member = newId('usr');
    ctx.store.join(ctx.ws, member, 'member');
    const failures = [
      await listAs(ctx, ctx.ws, member),
      await listAs(ctx, newId('wsp'), ctx.owner),
      await listAs(ctx, ctx.ws, ctx.owner, 'cursor=a.b.c'),
      await listAs(ctx, ctx.ws, ctx.owner, 'limit=0'),
    ];
    expect(failures.map((r) => r.statusCode)).toEqual([403, 404, 400, 422]);
    for (const response of failures) {
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(String(response.headers['x-request-id'])).toMatch(REQUEST_ID_PATTERN);
      for (const header of RATE_HEADERS) expect(response.headers[header], header).toBeDefined();
      const problem = response.json<Record<string, unknown>>();
      expect(problem).toMatchObject({ status: response.statusCode });
      expect(typeof problem['code']).toBe('string');
      expect(typeof problem['type']).toBe('string');
    }
    await ctx.app.close();
  });

  it('answers a valid InvoicePage of Money amounts, and nothing of the Stripe objects', async () => {
    const ctx = await withWorkspace();
    ctx.stripe.add(ctx.customer, ...allFixtures(ctx.customer));
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${ctx.ws}/invoices?limit=200`,
      headers: asUser(ctx.owner, READ),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: Record<string, unknown>[] }>();
    expect(validate('api/InvoicePage', body).ok).toBe(true);
    expect(body.data).toHaveLength(FIXTURES.length - 1);
    for (const invoice of body.data) {
      expect(validate('api/Invoice', invoice).ok).toBe(true);
      expect(Object.keys(invoice).filter((key) => /tax|customer|payment/.test(key))).toEqual([]);
      for (const field of ['amount_due', 'amount_paid'] as const) {
        const amount = invoice[field] as { amount: number; currency: string };
        expect(Number.isInteger(amount.amount)).toBe(true);
        expect(['USD', 'EUR']).toContain(amount.currency);
      }
    }
    // The public ids are random ULIDs: leave them out of the pattern checks.
    const text = JSON.stringify(body.data, (key, value: unknown) =>
      key === 'id' ? undefined : value,
    );
    expect(body.data.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(i['id'])))).toBe(true);
    expect(response.body).not.toContain(ctx.customer);
    expect(text).not.toMatch(
      /cus_|pi_|pm_|ch_|sub_|txr_|price_|il_|di_|in_|"object"|livemode|lines/,
    );
    expect(text).not.toMatch(
      /billing@fixture|Fixture (Corp|GmbH)|Springfield|1 Fixture Way|us_ein|00-0000000/,
    );
    expect(text).not.toMatch(/last4|brand|exp_month|card|GBP/i);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const logs = ctx.captured.raw();
    expect(logs).not.toContain(ctx.customer);
    expect(logs).not.toMatch(/https:\/\/(invoice|pay)\.stripe\.com|billing@fixture/);
    await ctx.app.close();
  });
});
