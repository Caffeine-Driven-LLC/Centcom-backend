/**
 * What trials and promotions (B079) need from elsewhere, as interfaces, so they run against fakes
 * in tests:
 *
 * - `PromotionStripe`: finding and retrieving promotion codes, reading a subscription's discounts
 *   and products, and adding a promotion code to a subscription. B070's `StripeClient` implements
 *   it; the objects come back as Stripe sent them and are checked by `parsePromotionCode` (the
 *   subscription by B070's `parseStripeSubscription`).
 * - `TrialMail`: B032's email service (`send` with an idempotency key, and the template registry).
 *
 * Owns: the interfaces. Must not: carry a code or a payload beyond the parsers.
 */
import type { EmailService } from '@centcom/core';
import type { StripeSub } from '../stripe/gateway.js';

/** A subscription's discounts and products, as Stripe reports them. */
export interface SubscriptionDiscounts {
  /** The discounts already on the subscription: `di_…`, and the `promo_…` it came from, if any. */
  discounts: { id: string; promotionCodeId: string | null }[];
  /** `prod_…` of its items' prices. */
  productIds: string[];
}

/** Adding a promotion code to a subscription. */
export interface ApplyPromotionInput {
  subscriptionId: string;
  /** `promo_…`. */
  promotionCodeId: string;
  /** The discounts to keep (Stripe replaces the list it is given). */
  keepDiscountIds: string[];
}

/** The Stripe calls of trials and promotions. */
export interface PromotionStripe {
  /**
   * The active promotion codes with this (case-insensitive) code, as Stripe sent them (one per
   * customer restriction at most; empty when there is none).
   */
  findPromotionCodes(code: string): Promise<unknown[]>;
  /** Promotion code `promo_…`, as Stripe sent it. */
  retrievePromotionCode(id: string): Promise<unknown>;
  /** The subscription's discounts and products. */
  subscriptionDiscounts(subscriptionId: string): Promise<SubscriptionDiscounts>;
  /** The subscription (B070's parsed view). */
  retrieveSubscription(id: string): Promise<StripeSub>;
  /** Adds the promotion to the subscription; the subscription after it. */
  applyPromotionCode(input: ApplyPromotionInput, idempotencyKey: string): Promise<StripeSub>;
}

/** B032's email service, as the trial-ending mail uses it. */
export type TrialMail = Pick<EmailService, 'send' | 'templates'>;
