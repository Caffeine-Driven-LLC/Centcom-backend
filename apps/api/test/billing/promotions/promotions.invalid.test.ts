/**
 * Codes that cannot be redeemed (B079 acceptance 3, guardrails "MUST NOT reveal whether a code
 * exists" and "MUST apply a coupon at most once per workspace per promotion even under concurrent
 * requests", failure mode "concurrent redeem of one single-use code by two workspaces", test plan
 * "contract: error bodies conform to CT-ERR"):
 *
 * - unknown, inactive, expired (code or coupon), exhausted (code or coupon), for another
 *   customer, first-time only on a billed subscription, for other products, in another currency,
 *   already redeemed by this workspace, refused by Stripe, or not even shaped like a code: every
 *   one is the same 422 problem+json `coupon_invalid` with `errors[0].pointer` `/code` and one
 *   detail text, so nothing tells whether a code exists (the reason is only in a metric);
 * - a body that is not `CouponRedeem` is 422 `validation_failed`;
 * - a workspace with no subscription in effect is 403 `subscription_inactive`, before any Stripe
 *   call;
 * - two workspaces racing for a single-use code: exactly one 200, the other the generic 422; one
 *   workspace redeeming one code twice at once: one 200 and one Stripe application.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { createWorkspace } from '../../modules/workspaces/helpers.js';
import {
  newCode,
  newId,
  PRO_PRODUCT,
  promotionCode,
  redeemAs,
  stripeId,
  stripeSub,
  withSubscription,
} from './helpers.js';

const NOW_S = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000;

/** The parts of a refusal that must be identical whatever the reason. */
const shape = (body: Record<string, unknown>) => ({
  type: body['type'],
  title: body['title'],
  status: body['status'],
  code: body['code'],
  detail: body['detail'],
  errors: body['errors'],
});

describe('codes that cannot be redeemed', () => {
  it('answers every refusal the same 422 coupon_invalid at /code', async () => {
    // More attempts than the hourly limit allows: the limit is the rate test's.
    const ctx = await withSubscription({ redeemRatePerHour: 100 });
    const cases: [string, Record<string, unknown> | null, unknown][] = [
      ['unknown', null, newCode()],
      ['inactive code', promotionCode(newCode(), { active: false }), null],
      ['invalid coupon', promotionCode(newCode(), { coupon: { valid: false } }), null],
      ['expired code', promotionCode(newCode(), { expires_at: NOW_S - 1 }), null],
      ['expired coupon', promotionCode(newCode(), { coupon: { redeem_by: NOW_S - 60 } }), null],
      ['exhausted code', promotionCode(newCode(), { max_redemptions: 5, times_redeemed: 5 }), null],
      [
        'exhausted coupon',
        promotionCode(newCode(), { coupon: { max_redemptions: 1, times_redeemed: 1 } }),
        null,
      ],
      ['other customer', promotionCode(newCode(), { customer: stripeId('cus') }), null],
      ['first-time only', promotionCode(newCode(), { first_time_transaction: true }), null],
      [
        'other product',
        promotionCode(newCode(), { coupon: { applies_to: { products: [PRO_PRODUCT] } } }),
        null,
      ],
      [
        'other currency',
        promotionCode(newCode(), {
          coupon: { percent_off: null, amount_off: 500, currency: 'usd' },
        }),
        null,
      ],
      ['whitespace', null, 'SPRING 25'],
      ['control character', null, 'SPRING\u000125'],
      ['blank', null, '   '],
    ];
    const shapes: unknown[] = [];
    for (const [name, promo, raw] of cases) {
      if (promo !== null) ctx.stripe.codes.push(promo);
      const code = raw ?? promo?.['code'];
      const response = await redeemAs(ctx, ctx.ws, ctx.owner, { code });
      expect(response.statusCode, name).toBe(422);
      expect(response.headers['content-type'], name).toMatch(/^application\/problem\+json/);
      const body = response.json<Record<string, unknown>>();
      expect(body, name).toMatchObject({
        code: 'coupon_invalid',
        status: 422,
        errors: [{ pointer: '/code', code: 'coupon_invalid' }],
      });
      expect(response.body, name).not.toContain(String(code));
      shapes.push(shape(body));
    }
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(0);
    expect(ctx.mirror.redemptions.size).toBe(0);
    for (const reason of ['unknown', 'expired', 'exhausted', 'customer', 'first_time', 'plan']) {
      expect(ctx.recorded.count('coupon_refusals_total', { reason }), reason).toBeGreaterThan(0);
    }
    await ctx.app.close();
  });

  it('refuses a code Stripe refuses, and an already-redeemed one, the same way', async () => {
    const ctx = await withSubscription();
    const refused = promotionCode(newCode());
    ctx.stripe.codes.push(refused);
    ctx.stripe.failures.apply = [new StripeError('request', 'coupon not applicable', 400)];
    const first = await redeemAs(ctx, ctx.ws, ctx.owner, { code: refused['code'] });
    const used = promotionCode(newCode());
    ctx.stripe.codes.push(used);
    await redeemAs(ctx, ctx.ws, ctx.owner, { code: used['code'] });
    const second = await redeemAs(ctx, ctx.ws, ctx.owner, { code: used['code'] });
    expect([first.statusCode, second.statusCode]).toEqual([422, 422]);
    expect(shape(first.json())).toEqual(shape(second.json()));
    expect([...ctx.mirror.redemptions.values()].map((r) => r.stripePromotionId)).toEqual([
      used['id'],
    ]);
    await ctx.app.close();
  });

  it('makes the same Stripe calls for an unknown code as for one that exists but is refused', async () => {
    const ctx = await withSubscription();
    const expired = promotionCode(newCode(), { expires_at: NOW_S - 1 });
    ctx.stripe.codes.push(expired);
    await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() });
    const unknown = ctx.stripe.calls
      .splice(0)
      .map((c) => c.kind)
      .sort();
    await redeemAs(ctx, ctx.ws, ctx.owner, { code: expired['code'] });
    const refused = ctx.stripe.calls
      .splice(0)
      .map((c) => c.kind)
      .sort();
    expect(unknown).toEqual(['discounts', 'find']);
    expect(refused).toEqual(unknown);
    await ctx.app.close();
  });

  it('answers 422 validation_failed for a body that is not CouponRedeem', async () => {
    const ctx = await withSubscription();
    for (const body of [{}, { code: 7 }, { code: '' }, { code: 'X'.repeat(65) }, ['X']]) {
      const response = await redeemAs(ctx, ctx.ws, ctx.owner, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    }
    expect(ctx.stripe.calls).toHaveLength(0);
    await ctx.app.close();
  });

  it('answers 403 subscription_inactive without a subscription in effect, asking Stripe nothing', async () => {
    const ctx = await withSubscription({}, 'canceled');
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    const canceled = await redeemAs(ctx, ctx.ws, ctx.owner, { code });
    expect(canceled.statusCode).toBe(403);
    expect(canceled.json<{ code: string }>().code).toBe('subscription_inactive');
    const bare = (await createWorkspace(ctx.app, ctx.owner, 'Free')).id;
    const none = await redeemAs(ctx, bare, ctx.owner, { code });
    expect(none.statusCode).toBe(403);
    expect(ctx.stripe.calls).toHaveLength(0);
    await ctx.app.close();
  });

  it('lets one of two workspaces racing for a single-use code win', async () => {
    const ctx = await withSubscription();
    const second = (await createWorkspace(ctx.app, ctx.owner, 'Second')).id;
    const customer = stripeId('cus');
    ctx.billing.customers.set(second, customer);
    const sub = stripeSub(customer);
    await ctx.billingService.upsertFromStripe(sub, 100);
    ctx.stripe.addSubscription(sub);
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code, { max_redemptions: 1 }));
    let release = (): void => undefined;
    ctx.stripe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = [ctx.ws, second].map((ws) => redeemAs(ctx, ws, ctx.owner, { code }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.stripe.gate = null;
    release();
    const statuses = (await Promise.all(racing)).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 422]);
    expect(ctx.mirror.redemptions.size).toBe(1);
    await ctx.app.close();
  });

  it('applies a code once when one workspace redeems it twice at once', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    let release = (): void => undefined;
    ctx.stripe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const twice = [1, 2].map(() => redeemAs(ctx, ctx.ws, ctx.owner, { code }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.stripe.gate = null;
    release();
    const statuses = (await Promise.all(twice)).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 422]);
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(1);
    expect([...ctx.mirror.redemptions.values()][0]?.codeHash).toBe(
      createHash('sha256').update(code).digest('hex'),
    );
    expect(newId('wsp')).not.toBe(ctx.ws);
    await ctx.app.close();
  });
});
