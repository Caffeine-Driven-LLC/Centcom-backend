/**
 * Stripe promotion codes as B079 reads them (Stripe API 2025-03-31.basil: the coupon is on the
 * promotion code, `applies_to` when expanded).
 *
 * - `parsePromotionCode` keeps what the checks need: ids, whether it is active, expiry, redemption
 *   limits, the customer it is restricted to, the first-time restriction, and the coupon's
 *   validity, expiry, limits, currency and the products it applies to; of the code text only its
 *   hash (`codeHash`, for a staff grant's ledger row). Never names or metadata.
 * - `checkPromotion` says why a promotion cannot be applied to a workspace's subscription, or
 *   null when it can: inactive, expired, exhausted, restricted to another customer, first-time
 *   only (for a subscription that has been billed), for other products, or in another currency.
 *   The reason is for metrics and logs only: the API answers every refusal the same way (B079
 *   guardrail "MUST NOT reveal whether a code exists").
 *
 * Owns: reading promotion codes and the checks. Must not: keep or log a code or a payload.
 */
import { StripeError } from '../stripe/gateway.js';
import { codeHash, normaliseCode } from './codes.js';

/** A promotion code, as the checks read it. */
export interface PromotionCode {
  /** `promo_…`. */
  id: string;
  /** sha256 (hex) of the normalised code, or null when Stripe sent none. */
  codeHash: string | null;
  active: boolean;
  /** Unix seconds, or null. */
  expiresAt: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  /** The customer it is restricted to (`cus_…`), or null. */
  customerId: string | null;
  firstTimeOnly: boolean;
  coupon: {
    valid: boolean;
    /** Unix seconds, or null. */
    redeemBy: number | null;
    maxRedemptions: number | null;
    timesRedeemed: number;
    /** Upper case, for an amount-off coupon; null for a percentage. */
    amountCurrency: string | null;
    /** Currencies an amount-off coupon also has amounts in (upper case). */
    currencyOptions: string[];
    /** Stripe product ids it is limited to, or null for all. */
    products: string[] | null;
  };
}

/** Why a promotion cannot be applied (metrics and logs only; never shown). */
export type PromotionRefusal =
  'inactive' | 'expired' | 'exhausted' | 'customer' | 'first_time' | 'plan' | 'currency';

/** The subscription a promotion would apply to. */
export interface PromotionTarget {
  /** Unix seconds. */
  now: number;
  /** The workspace's `cus_…`. */
  customerId: string;
  /** The contract status (`active`, `trialing`, `past_due`). */
  status: string;
  /** ISO 4217, upper case. */
  currency: string;
  /** The products of the subscription's items. */
  productIds: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const idOf = (value: unknown): string | null => {
  const id = isRecord(value) ? value['id'] : value;
  return typeof id === 'string' ? id : null;
};

const invalid = (what: string): StripeError =>
  new StripeError('invalid_response', `Stripe promotion code: ${what}`);

/** The checks' view of a Stripe promotion code; a StripeError for anything else. */
export function parsePromotionCode(raw: unknown): PromotionCode {
  if (!isRecord(raw) || raw['object'] !== 'promotion_code') throw invalid('not a promotion code');
  const id = raw['id'];
  if (typeof id !== 'string' || !/^promo_[A-Za-z0-9]{1,250}$/.test(id)) throw invalid('id');
  const coupon = raw['coupon'];
  if (!isRecord(coupon)) throw invalid('coupon');
  const restrictions = isRecord(raw['restrictions']) ? raw['restrictions'] : {};
  const appliesTo = isRecord(coupon['applies_to']) ? coupon['applies_to']['products'] : undefined;
  const options = isRecord(coupon['currency_options'])
    ? Object.keys(coupon['currency_options'])
    : [];
  const customer = idOf(raw['customer']);
  const code = normaliseCode(raw['code']);
  return {
    id,
    codeHash: code === null ? null : codeHash(code),
    active: raw['active'] === true,
    expiresAt: count(raw['expires_at']),
    maxRedemptions: count(raw['max_redemptions']),
    timesRedeemed: count(raw['times_redeemed']) ?? 0,
    customerId: customer,
    firstTimeOnly: restrictions['first_time_transaction'] === true,
    coupon: {
      valid: coupon['valid'] === true,
      redeemBy: count(coupon['redeem_by']),
      maxRedemptions: count(coupon['max_redemptions']),
      timesRedeemed: count(coupon['times_redeemed']) ?? 0,
      amountCurrency:
        count(coupon['amount_off']) !== null && typeof coupon['currency'] === 'string'
          ? coupon['currency'].toUpperCase()
          : null,
      currencyOptions: options.map((c) => c.toUpperCase()),
      products: Array.isArray(appliesTo)
        ? appliesTo.filter((p): p is string => typeof p === 'string')
        : null,
    },
  };
}

/** Why `promo` cannot be applied to `target`, or null when it can. */
export function checkPromotion(
  promo: PromotionCode,
  target: PromotionTarget,
): PromotionRefusal | null {
  const { coupon } = promo;
  if (!promo.active || !coupon.valid) return 'inactive';
  if (promo.expiresAt !== null && promo.expiresAt <= target.now) return 'expired';
  if (coupon.redeemBy !== null && coupon.redeemBy <= target.now) return 'expired';
  if (promo.maxRedemptions !== null && promo.timesRedeemed >= promo.maxRedemptions) {
    return 'exhausted';
  }
  if (coupon.maxRedemptions !== null && coupon.timesRedeemed >= coupon.maxRedemptions) {
    return 'exhausted';
  }
  if (promo.customerId !== null && promo.customerId !== target.customerId) return 'customer';
  // First-time codes are for customers with no payment yet: a subscription still in its trial.
  if (promo.firstTimeOnly && target.status !== 'trialing') return 'first_time';
  if (coupon.products !== null && coupon.products.length > 0) {
    if (!coupon.products.some((p) => target.productIds.includes(p))) return 'plan';
  }
  if (
    coupon.amountCurrency !== null &&
    coupon.amountCurrency !== target.currency &&
    !coupon.currencyOptions.includes(target.currency)
  ) {
    return 'currency';
  }
  return null;
}
