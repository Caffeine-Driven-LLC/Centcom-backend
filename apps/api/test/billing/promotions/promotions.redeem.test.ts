/**
 * Redeeming a coupon (B079 acceptance 1, 2 and 7, test plan "integration: redeem happy path and
 * replay with the Stripe fake", guardrails "MUST NOT store plaintext coupon codes anywhere" and
 * "MUST apply a coupon at most once per workspace per promotion"):
 *
 * - a valid code redeemed by the owner answers 200 with the workspace's `Subscription`; Stripe
 *   gets the promotion once, keeping the subscription's other discounts, with an idempotency key
 *   per workspace and promotion; one audit event `billing.coupon` (CT-API-AUDIT's name) is
 *   written with the redemption; entitlements' `rev` moves only when the entitlements changed (a
 *   discount changes none);
 * - the same Idempotency-Key and body replays the stored 200 with `Idempotency-Replayed: true`
 *   and applies nothing more; the same key with another code is 409 `idempotency_conflict`;
 * - the code is matched case-insensitively and whitespace-trimmed, and only its sha256 is kept:
 *   not in the ledger, the logs, the audit event or the response.
 */
import { createHash, randomUUID } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { AUDIT_BATCH_INTERVAL_MS } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { newCode, promotionCode, redeemAs, withSubscription } from './helpers.js';

describe('POST /v1/workspaces/{id}/coupons/redeem', () => {
  it('applies a valid code once and answers the subscription, with one audit event', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    const promo = promotionCode(code);
    ctx.stripe.codes.push(promo);
    const kept = 'di_FixtureExisting';
    const entry = ctx.stripe.subscriptions.get(ctx.sub.id);
    if (entry !== undefined) entry.discounts = [{ id: kept, promotionCodeId: null }];
    const revBefore = ctx.entitlements.revs.get(ctx.ws);

    const response = await redeemAs(ctx, ctx.ws, ctx.owner, { code: ` ${code.toLowerCase()} ` });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(validate('api/Subscription', body).ok).toBe(true);
    expect(body).toMatchObject({ workspace: ctx.ws, plan: 'team', status: 'active', seats: 8 });
    expect(response.headers['cache-control']).toBe('no-store');

    const applies = ctx.stripe.calls.filter((c) => c.kind === 'apply');
    expect(applies).toEqual([
      {
        kind: 'apply',
        arg: promo['id'],
        idempotencyKey: `centcom-${ctx.ws}-promo-${String(promo['id'])}`,
      },
    ]);
    expect(ctx.stripe.calls.find((c) => c.kind === 'find')?.arg).toBe(code);
    expect(ctx.stripe.discountsOf(ctx.sub.id)).toEqual([
      { id: kept, promotionCodeId: null },
      { id: expect.stringMatching(/^di_/), promotionCodeId: promo['id'] },
    ]);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(revBefore);

    expect([...ctx.mirror.redemptions.values()]).toEqual([
      expect.objectContaining({
        workspaceId: ctx.ws,
        userId: ctx.owner,
        codeHash: createHash('sha256').update(code).digest('hex'),
        stripePromotionId: promo['id'],
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(ctx.mirror.audit).toEqual([
      expect.objectContaining({
        action: 'billing.coupon',
        workspace_id: ctx.ws,
        actor_id: ctx.owner,
        target_id: ctx.ws,
        outcome: 'success',
      }),
    ]);
    expect(String(ctx.mirror.audit[0]?.['meta'])).toContain('team');
    expect(ctx.recorded.count('coupon_redemptions_total', { outcome: 'redeemed' })).toBe(1);
    await ctx.app.close();
  });

  it('replays the same key and body, applying once; refuses the key with another code', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code), promotionCode(newCode()));
    const headers = { 'idempotency-key': randomUUID() };
    const first = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(first.statusCode).toBe(200);
    const again = await redeemAs(ctx, ctx.ws, ctx.owner, { code }, headers);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(1);
    expect(ctx.mirror.redemptions.size).toBe(1);

    const other = await redeemAs(ctx, ctx.ws, ctx.owner, { code: 'OTHER1' }, headers);
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
    await ctx.app.close();
  });

  it('never keeps, logs or audits the code', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    await redeemAs(ctx, ctx.ws, ctx.owner, { code });
    await redeemAs(ctx, ctx.ws, ctx.owner, { code: newCode() });
    await redeemAs(ctx, ctx.ws, ctx.owner, { code: `${code} X` });
    await ctx.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    const everything = JSON.stringify([
      [...ctx.mirror.redemptions.values()],
      ctx.mirror.audit,
      ctx.detached,
      ctx.captured.raw(),
    ]);
    expect(everything).not.toContain(code);
    expect(everything.toUpperCase()).not.toContain(code);
    await ctx.app.close();
  });

  it('applies a promotion once per workspace: a second redemption is the generic refusal', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(200);
    const again = await redeemAs(ctx, ctx.ws, ctx.owner, { code });
    expect(again.statusCode).toBe(422);
    expect(again.json<{ code: string }>().code).toBe('coupon_invalid');
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(1);
    expect(ctx.recorded.count('coupon_refusals_total', { reason: 'already_redeemed' })).toBe(1);
    await ctx.app.close();
  });

  it('takes an amount-off coupon in another currency that has an amount in this one', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    ctx.stripe.codes.push(
      promotionCode(code, {
        coupon: {
          percent_off: null,
          amount_off: 500,
          currency: 'usd',
          currency_options: { eur: { amount_off: 450 } },
        },
      }),
    );
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(200);
    await ctx.app.close();
  });

  it('uses the code meant for this customer, else the general one, of codes sharing a text', async () => {
    const ctx = await withSubscription();
    const code = newCode();
    const elsewhere = promotionCode(code, { customer: 'cus_FixtureSomeoneElse' });
    const general = promotionCode(code);
    ctx.stripe.codes.push(elsewhere, general);
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code })).statusCode).toBe(200);
    expect(ctx.stripe.discountsOf(ctx.sub.id).map((d) => d.promotionCodeId)).toEqual([
      general['id'],
    ]);
    const mine = newCode();
    const forUs = promotionCode(mine, { customer: ctx.customer });
    ctx.stripe.codes.push(promotionCode(mine), forUs);
    expect((await redeemAs(ctx, ctx.ws, ctx.owner, { code: mine })).statusCode).toBe(200);
    expect(ctx.stripe.discountsOf(ctx.sub.id).map((d) => d.promotionCodeId)).toContain(forUs['id']);
    await ctx.app.close();
  });

  it('keeps both discounts when two promotions are redeemed at once', async () => {
    const ctx = await withSubscription();
    const [one, two] = [newCode(), newCode()];
    ctx.stripe.codes.push(promotionCode(one), promotionCode(two));
    let release = (): void => undefined;
    ctx.stripe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = [one, two].map((code) => redeemAs(ctx, ctx.ws, ctx.owner, { code }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.stripe.gate = null;
    release();
    expect((await Promise.all(both)).map((r) => r.statusCode)).toEqual([200, 200]);
    expect(ctx.stripe.discountsOf(ctx.sub.id)).toHaveLength(2);
    expect(ctx.mirror.redemptions.size).toBe(2);
    await ctx.app.close();
  });

  it('applies to a trialing subscription too, and answers its trial end', async () => {
    const ctx = await withSubscription({}, 'trialing');
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code, { first_time_transaction: true }));
    const response = await redeemAs(ctx, ctx.ws, ctx.owner, { code });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; trial_end: string | null }>()).toMatchObject({
      status: 'trialing',
      trial_end: expect.any(String),
    });
    await ctx.app.close();
  });
});
