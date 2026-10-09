/**
 * `grantPromotion` for internal callers (B079 interface "grantPromotion(workspaceId,
 * promotionCodeId, actor): Promise<Subscription>", scope_out "B087 may call grantPromotion"):
 *
 * - it satisfies B087's `PromotionGranter` port (staff actor) as it is;
 * - a staff grant applies the promotion by id with the same checks and ledger (no user, the
 *   code's hash from Stripe's object, no fingerprint), no rate limit, and writes the workspace's
 *   `billing.coupon` event with the staff actor when an audit emitter is given;
 * - refusals are the same generic 422 `coupon_invalid`, at `/promotion_code_id`; a workspace with
 *   no subscription in effect is 403 `subscription_inactive`; a second grant is refused.
 */
import { createMemoryRedis, type AuditDb, type AuditEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { PromotionGranter } from '../../../src/modules/admin/ports.js';
import { PromotionService } from '../../../src/modules/billing/promotions/service.js';
import { newCode, newId, promotionCode, withSubscription } from './helpers.js';

async function setup() {
  const ctx = await withSubscription();
  const emitted: AuditEvent[] = [];
  const service = new PromotionService({
    repository: ctx.mirror.repository,
    billingRepository: ctx.billing.repository,
    billing: ctx.billingService,
    stripe: ctx.stripe,
    rateLimit: { consume: () => Promise.reject(new Error('grants are not rate limited')) },
    locks: createMemoryRedis().kv,
    config: { redeemRatePerHour: 1 },
    audit: {
      emit: (_trx: AuditDb, event: AuditEvent) => {
        emitted.push(event);
        return Promise.resolve('aud_x');
      },
    },
  });
  const granter: PromotionGranter = service;
  return { ...ctx, service, granter, emitted };
}

describe('grantPromotion', () => {
  it('applies a promotion for staff, with the ledger and a staff audit event', async () => {
    const t = await setup();
    const promo = promotionCode(newCode());
    t.stripe.codes.push(promo);
    const staff = newId('usr');
    const sub = await t.granter.grantPromotion(t.ws, String(promo['id']), {
      type: 'staff',
      id: staff,
    });
    expect(sub).toMatchObject({ workspace: t.ws, plan: 'team', status: 'active' });
    expect(t.stripe.calls.map((c) => c.kind)).toEqual([
      'retrieve',
      'discounts',
      'discounts',
      'apply',
    ]);
    expect([...t.mirror.redemptions.values()]).toEqual([
      expect.objectContaining({
        userId: null,
        requestFingerprint: null,
        stripePromotionId: promo['id'],
        codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(t.emitted).toEqual([
      expect.objectContaining({
        workspaceId: t.ws,
        action: 'billing.coupon',
        actor: { type: 'staff', id: staff },
        outcome: 'success',
        meta: { plan: 'team' },
      }),
    ]);
    const again = await t.service
      .grantPromotion(t.ws, String(promo['id']), { type: 'staff', id: staff })
      .catch((e: unknown) => e);
    expect(again).toMatchObject({
      code: 'coupon_invalid',
      errors: [{ pointer: '/promotion_code_id', code: 'coupon_invalid' }],
    });
    await t.app.close();
  });

  it('refuses unknown, malformed and invalid promotions the generic way', async () => {
    const t = await setup();
    const expired = promotionCode(newCode(), { active: false });
    t.stripe.codes.push(expired);
    for (const id of ['promo_Missing1', 'not-a-promo', String(expired['id'])]) {
      const error = await t.service
        .grantPromotion(t.ws, id, { kind: 'user', userId: newId('usr'), scopes: [] })
        .catch((e: unknown) => e);
      expect(error, id).toMatchObject({ code: 'coupon_invalid' });
    }
    expect(t.mirror.redemptions.size).toBe(0);
    await t.app.close();
  });

  it('answers 403 subscription_inactive for a workspace without a subscription', async () => {
    const t = await setup();
    const promo = promotionCode(newCode());
    t.stripe.codes.push(promo);
    const error = await t.service
      .grantPromotion(newId('wsp'), String(promo['id']), { type: 'staff', id: newId('usr') })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'subscription_inactive' });
    await t.app.close();
  });
});
