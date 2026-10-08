/**
 * Table types of billing (B070, migration 20260102003200_billing_customers_subscriptions.sql).
 * Written by the subscriptions repository (apps/api `modules/billing/subscriptions/repository.ts`):
 * Stripe ids and the subscription's state, never card data or full Stripe payloads.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface BillingCustomerTable {
  workspace_id: Fixed<string>;
  /** `cus_…`. */
  stripe_customer_id: Fixed<string>;
  created_at: CreatedAt;
}

export interface BillingSubscriptionTable {
  workspace_id: Fixed<string>;
  /** The Centcom `sub_` id (CT-IDS). */
  id: Fixed<string>;
  /** Stripe's `sub_…`; never shown. */
  stripe_subscription_id: string;
  plan: 'pro' | 'team';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  interval: 'month' | 'year';
  /** ISO 4217, upper case, as Stripe returned it. */
  currency: string;
  period_start: Date | null;
  period_end: Date | null;
  /** Total seats: the plan's included seats plus add-on seats. */
  seats: number;
  cancel_at_period_end: boolean;
  past_due_since: Date | null;
  updated_at: Date;
  /** Unix seconds of the Stripe event the row was written from: the stale-event guard. */
  stripe_event_created: ColumnType<string, number, number>;
}

/** The billing tables. */
export interface BillingDatabase {
  billing_customer: BillingCustomerTable;
  billing_subscription: BillingSubscriptionTable;
}

/** The core tables and billing. */
export type BillingDb = CoreDatabase & BillingDatabase;
