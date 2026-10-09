/**
 * The redeem endpoint on the wire (B079 test plan "contract: error bodies conform to CT-ERR;
 * Idempotency-Key behaviour conforms to CT-PAGE"):
 *
 * - every error (422 `coupon_invalid` and `validation_failed`, 403, 404, 409, 429, 503) is
 *   problem+json that validates as `api/Problem`, and uses only codes CT-API-BILLING lists for
 *   `redeemCoupon`;
 * - success and errors carry `X-Request-Id` and the `RateLimit-*` headers; the 200 validates as
 *   `api/Subscription`;
 * - Idempotency-Key per CT-PAGE: a replay is `Idempotency-Replayed: true` with the stored body; a
 *   different body under one key is 409 `idempotency_conflict`; a 5xx is not stored (a retry runs).
 */
import { randomUUID } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { REQUEST_ID_PATTERN } from '../../helpers.js';
import { newCode, newId, promotionCode, redeemAs, withSubscription } from './helpers.js';

/** CT-API-BILLING `redeemCoupon` x-error-codes. */
const LISTED = new Set([
  'rate_limited',
  'internal_error',
  'service_unavailable',
  'coupon_invalid',
  'subscription_inactive',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'validation_failed',
  'idempotency_conflict',
]);

describe('POST /v1/workspaces/{id}/coupons/redeem on the wire', () => {
  it('answers problem+json per CT-ERR with listed codes, and the CT-PAGE headers', async () => {
    const ctx = await withSubscription({ rateLimit: true, redeemRatePerHour: 5 });
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    const member = newId('usr');
    ctx.store.join(ctx.ws, member, 'member');
    const key = { 'idempotency-key': randomUUID() };

    const ok = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, key);
    expect(ok.statusCode).toBe(200);
    expect(validate('api/Subscription', ok.json()).ok).toBe(true);
    const responses = [
      ok,
      await redeemAs(ctx, ctx.ws, ctx.owner, { code: 'OTHER1' }, key),
      await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }),
      await redeemAs(ctx, ctx.ws, ctx.owner, {}),
      await redeemAs(ctx, ctx.ws, member, { code }),
      await redeemAs(ctx, newId('wsp'), ctx.owner, { code }),
    ];
    ctx.stripe.failures.find = [new StripeError('unavailable', 'down')];
    responses.push(await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }));
    responses.push(await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 409, 422, 422, 403, 404, 503, 429]);

    for (const response of responses) {
      expect(String(response.headers['x-request-id'])).toMatch(REQUEST_ID_PATTERN);
      for (const header of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
        expect(response.headers[header], `${response.statusCode} ${header}`).toBeDefined();
      }
      if (response.statusCode === 200) continue;
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      const problem = response.json<Record<string, unknown>>();
      expect(validate('api/Problem', problem).ok, JSON.stringify(problem)).toBe(true);
      expect(LISTED.has(String(problem['code'])), String(problem['code'])).toBe(true);
      expect(problem['status']).toBe(response.statusCode);
    }
    await ctx.app.close();
  });

  it('replays the stored answer, and does not store a 5xx', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    const key = { 'idempotency-key': randomUUID() };
    ctx.stripe.failures.apply = [new StripeError('unavailable', 'down')];
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code }, key)).statusCode).toBe(503);
    const first = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, key);
    const replay = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, key);
    expect(first.statusCode).toBe(200);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toBe(first.body);
    await ctx.app.close();
  });
});
