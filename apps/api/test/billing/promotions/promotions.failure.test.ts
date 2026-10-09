/**
 * Stripe failures (B079 test plan "failure-path: Stripe timeout -> 503 with retry_after_s, no
 * ledger row, safe to retry with the same key", failure mode "Stripe error after ledger insert ->
 * roll back the ledger row in the same transaction, return 503, client may retry with the same
 * key"):
 *
 * - Stripe unreachable when applying: 503 `service_unavailable` with `retry_after_s` and
 *   `Retry-After`, no ledger row, no audit event; the same key then redeems (B024 keeps no 5xx)
 *   with the same Stripe idempotency key and parameters;
 * - Stripe applied it but the answer was lost (503 to the client): the retry finds the promotion
 *   on the subscription, applies nothing more, records the row and the audit event and answers
 *   200, whether or not it carries the key;
 * - Stripe unreachable when finding the code or reading the subscription: the same 503;
 * - a rate-limit store that fails closes the endpoint (503), rather than letting brute force in;
 * - no database transaction is open while Stripe is called (the ledger row and the audit event are
 *   written after it);
 * - billing off (no Stripe key): 503;
 * - Stripe answering something that is not a promotion code: 500, logged.
 */
import { randomUUID } from 'node:crypto';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { PromotionService } from '../../../src/modules/billing/promotions/service.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { newCode, promotionCode, redeemAs, withSubscription } from './helpers.js';

const timeout = () =>
  new StripeError('unavailable', 'Stripe unavailable after 4 attempts (timed out)');

describe('Stripe failures', () => {
  it('answers 503 with retry_after_s and keeps no row; the same key then redeems once', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    ctx.stripe.failures.apply = [timeout()];
    const headers = { 'idempotency-key': randomUUID() };
    const failed = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(Number(failed.headers['retry-after'])).toBe(30);
    expect(failed.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 30 });
    expect(ctx.mirror.redemptions.size).toBe(0);
    expect(ctx.mirror.audit).toHaveLength(0);

    const retried = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(retried.statusCode).toBe(200);
    expect(retried.headers['idempotency-replayed']).toBeUndefined();
    expect(ctx.mirror.redemptions.size).toBe(1);
    expect(ctx.mirror.audit).toHaveLength(1);
    const keys = ctx.stripe.calls.filter((c) => c.kind === 'apply').map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    await ctx.app.close();
  });

  it('records a promotion Stripe applied though its answer was lost, applying nothing more', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code, { max_redemptions: 1 }));
    ctx.stripe.lostAnswers.push(timeout());
    const headers = { 'idempotency-key': randomUUID() };
    const lost = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(lost.statusCode).toBe(503);
    expect(ctx.mirror.redemptions.size).toBe(0);
    expect(ctx.stripe.discountsOf(ctx.sub.id)).toHaveLength(1);

    const retried = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(retried.statusCode).toBe(200);
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(1);
    expect(ctx.stripe.discountsOf(ctx.sub.id)).toHaveLength(1);
    expect(ctx.mirror.redemptions.size).toBe(1);
    expect(ctx.mirror.audit).toHaveLength(1);
    // A later request with the key answers as the first did; one without it is refused.
    const replay = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(replay.statusCode).toBe(200);
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(422);
    await ctx.app.close();
  });

  it('records a lost answer for a retry without the key too', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    ctx.stripe.lostAnswers.push(timeout());
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(503);
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(200);
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(1);
    expect(ctx.mirror.redemptions.size).toBe(1);
    await ctx.app.close();
  });

  it('answers 503 when Stripe is unreachable finding the code or reading the subscription', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    ctx.stripe.failures.find = [timeout()];
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(503);
    ctx.stripe.failures.discounts = [timeout()];
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(503);
    expect(ctx.mirror.redemptions.size).toBe(0);
    expect(ctx.recorded.count('coupon_redemptions_total', { outcome: 'stripe_unavailable' })).toBe(
      2,
    );
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(200);
    await ctx.app.close();
  });

  it('answers 500 when Stripe sends something that is not a promotion code', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push({ object: 'coupon', active: true, code, id: 'co_x' });
    const response = await redeemAs(ctx, ctx.ws, ctx.owner, { code });
    expect(response.statusCode).toBe(500);
    expect(ctx.captured.lines().some((l) => l['msg'] === 'billing.coupon_stripe_failed')).toBe(
      true,
    );
    await ctx.app.close();
  });

  it('answers 503 with billing off', async () => {
    const ctx = await withSubscription({ billingOff: true });
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() })).statusCode).toBe(503);
    await ctx.app.close();
  });

  it('closes the endpoint when the rate-limit store fails', async () => {
    const ctx = await withSubscription();
    const service = new PromotionService({
      repository: ctx.mirror.repository,
      billingRepository: ctx.billing.repository,
      billing: ctx.billingService,
      stripe: ctx.stripe,
      rateLimit: { consume: () => Promise.reject(new Error('redis down')) },
      locks: createMemoryRedis().kv,
      config: { redeemRatePerHour: 10 },
    });
    const error = await service.countAttempt(ctx.ws, '192.0.2.1').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'service_unavailable' });
    expect(ctx.stripe.calls).toHaveLength(0);
    await ctx.app.close();
  });
});
