/**
 * Table types of trials and promotions (B079, migration 20260102003800_coupon_redemptions.sql).
 * Written by the API's promotions repository (apps/api `modules/billing/promotions/`): the
 * redemption ledger (code hashes, never codes), the trials Stripe confirmed and their owners.
 */
import type { ColumnType } from 'kysely';
import type { BillingDb } from './billing.js';
import type { CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** `coupon_redemptions`: one row per promotion applied to a workspace. */
export interface CouponRedemptionsTable {
  /** A bare ULID (CT-IDS defines no prefix). */
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  /** The redeeming user; null for a staff grant, an API key or a deleted account. */
  user_id: ColumnType<string | null, string | null, never>;
  /** sha256 (hex) of the normalised code: never the code. */
  code_hash: Fixed<string>;
  /** Stripe's `promo_…`. */
  stripe_promotion_id: Fixed<string>;
  redeemed_at: CreatedAt;
  request_fingerprint: ColumnType<string | null, string | null, never>;
}

/** `billing_trials`: the trials Stripe confirmed, one per workspace. */
export interface BillingTrialsTable {
  /** Stripe's `sub_…` of the trialing subscription. */
  stripe_subscription_id: Fixed<string>;
  /** Null once the workspace is purged. */
  workspace_id: ColumnType<string | null, string, never>;
  trial_end: ColumnType<Date | null, Date | null, never>;
  created_at: CreatedAt;
}

/** `billing_trial_owners`: the workspace's owners when its trial was recorded. */
export interface BillingTrialOwnersTable {
  stripe_subscription_id: Fixed<string>;
  user_id: Fixed<string>;
  created_at: CreatedAt;
}

/** The promotion tables. */
export interface PromotionsDatabase {
  coupon_redemptions: CouponRedemptionsTable;
  billing_trials: BillingTrialsTable;
  billing_trial_owners: BillingTrialOwnersTable;
}

/** Billing and the promotion tables. */
export type PromotionsDb = BillingDb & PromotionsDatabase;
