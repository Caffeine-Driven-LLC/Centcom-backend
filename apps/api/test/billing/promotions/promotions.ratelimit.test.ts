/**
 * The redeem limit (B079 acceptance 5, test plan "abuse test: brute-force 11 attempts in an hour
 * -> 429 on the 11th"): 10 attempts per workspace per hour, valid or not, then 429 `rate_limited`
 * with `Retry-After` and `retry_after_s`; counted per workspace (whatever the address) and per
 * client address (whatever the workspace); free again once the hour has passed. The count is
 * taken before B024 claims the Idempotency-Key: a replay is an attempt, and a 429 is never kept
 * for replay (a retry after Retry-After runs). Callers refused by RBAC count for no one.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkspace } from '../../modules/workspaces/helpers.js';
import {
  newCode,
  newId,
  promotionCode,
  redeemAs,
  stripeId,
  stripeSub,
  withSubscription,
} from './helpers.js';

describe('the redeem limit', () => {
  it('answers the 11th attempt in an hour with 429 and Retry-After, per workspace', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      // A different address each time: the workspace's counter still fills.
      const response = await redeemAs(
        ctx,
        ctx.ws,
        ctx.owner,
        { code: i === 0 ? code : newCode() },
        {
          'x-test-ip': `198.51.100.${i + 1}`,
        },
      );
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 422, 422, 422, 422, 422, 422, 422, 422, 422]);
    const eleventh = await redeemAs(
      ctx,
      ctx.ws,
      ctx.owner,
      { code: newCode() },
      {
        'x-test-ip': '198.51.100.99',
      },
    );
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers['content-type']).toMatch(/^application\/problem\+json/);
    const retryAfter = Number(eleventh.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(eleventh.json()).toMatchObject({ code: 'rate_limited', retry_after_s: retryAfter });
    expect(ctx.recorded.count('coupon_redemptions_total', { outcome: 'rate_limited' })).toBe(1);

    ctx.advance(3_600_000);
    const later = await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() });
    expect(later.statusCode).toBe(422);
    await ctx.app.close();
  });

  it('counts per client address across workspaces', async () => {
    const ctx = await withSubscription();
    const second = (await createWorkspace(ctx.app, ctx.owner, 'Second')).id;
    const customer = stripeId('cus');
    ctx.billing.customers.set(second, customer);
    await ctx.billingService.upsertFromStripe(stripeSub(customer), 100);
    const ip = { 'x-test-ip': '203.0.113.7' };
    for (let i = 0; i < 10; i += 1) {
      const ws = i % 2 === 0 ? ctx.ws : second;
      expect((await redeemAs(ctx, ws, ctx.owner, { code: newCode() }, ip)).statusCode).toBe(422);
    }
    expect((await redeemAs(ctx, second, ctx.owner, { code: newCode() }, ip)).statusCode).toBe(429);
    // Another address still gets through for the workspace with attempts left.
    expect(
      (await redeemAs(ctx, second, ctx.owner, { code: newCode() }, { 'x-test-ip': '203.0.113.8' }))
        .statusCode,
    ).toBe(422);
    await ctx.app.close();
  });

  it('counts a replay as an attempt, and never stores a 429', async () => {
    const ctx = await withSubscription({ redeemRatePerHour: 2 });
    const body = { code: newCode() };
    const key = { 'idempotency-key': randomUUID() };
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, body, key)).statusCode).toBe(422);
    const replay = await redeemAs(ctx, ctx.ws, ctx.owner, body, key);
    expect(replay.statusCode).toBe(422);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const third = { 'idempotency-key': randomUUID() };
    const limited = await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }, third);
    expect(limited.statusCode).toBe(429);
    // After Retry-After, the same key runs again: the 429 was not kept for replay.
    ctx.advance(3_600_000);
    const later = await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }, third);
    expect(later.statusCode).toBe(422);
    expect(later.headers['idempotency-replayed']).toBeUndefined();
    await ctx.app.close();
  });

  it('counts IPv4 clients seen as IPv4-mapped IPv6 addresses one by one', async () => {
    const ctx = await withSubscription({ redeemRatePerHour: 1 });
    const second = (await createWorkspace(ctx.app, ctx.owner, 'Second')).id;
    const customer = stripeId('cus');
    ctx.billing.customers.set(second, customer);
    await ctx.billingService.upsertFromStripe(stripeSub(customer), 100);
    const first = { 'x-test-ip': '::ffff:198.51.100.7' };
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() }, first)).statusCode).toBe(
      422,
    );
    // Another workspace from another IPv4 client is not held back by the first one's attempt.
    expect(
      (
        await redeemAs(
          ctx,
          second,
          ctx.owner,
          { code: newCode() },
          { 'x-test-ip': '::ffff:203.0.113.9' },
        )
      ).statusCode,
    ).toBe(422);
    // The same client on another workspace is.
    const third = (await createWorkspace(ctx.app, ctx.owner, 'Third')).id;
    expect((await redeemAs(ctx, third, ctx.owner, { code: newCode() }, first)).statusCode).toBe(
      429,
    );
    await ctx.app.close();
  });

  it('counts a refused caller for no one', async () => {
    const ctx = await withSubscription({ redeemRatePerHour: 1 });
    const stranger = newId('usr');
    ctx.store.addUser(stranger);
    for (let i = 0; i < 3; i += 1) {
      expect((await redeemAs(ctx, ctx.ws, stranger, { code: newCode() })).statusCode).toBe(404);
    }
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() })).statusCode).toBe(422);
    await ctx.app.close();
  });
});
