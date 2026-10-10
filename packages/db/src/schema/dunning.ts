/**
 * Table types of dunning (B078, migration 20260102004300_subscription_dunning.sql). Written by
 * the dunning repository (apps/api `modules/billing/dunning/repository.ts`): states, times and an
 * invoice id, never card data, amounts or Stripe payloads.
 */
import type { ColumnType } from 'kysely';
import type { BillingDb } from './billing.js';
import type { CreatedAt } from './core.js';

/** A workspace's status as dunning moves it (CT-ENTITLEMENTS statuses). */
export type DunningStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

/** Why a workspace dropped to `none`. */
export type DunningNoneReason = 'grace_expired' | 'period_ended' | 'subscription_ended';

/** `subscription_dunning`: one row per workspace that had a billing event since B078. */
export interface SubscriptionDunningTable {
  workspace_id: ColumnType<string, string, never>;
  state: DunningStatus;
  /** Stripe's `in_…` of the open failure, when an invoice event named it. */
  failed_invoice: string | null;
  first_failed_at: Date | null;
  /** `first_failed_at` plus 7 days, while `past_due`. */
  grace_until: Date | null;
  /** A canceled subscription's period end. */
  period_end: Date | null;
  /** Grace-day reminders sent: 1 day 0, 2 day 3, 4 day 6. */
  reminders_sent: ColumnType<number, number | undefined, number>;
  none_at: Date | null;
  none_reason: DunningNoneReason | null;
  /** When the drop to `none` was announced. */
  announced_at: Date | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** The dunning table. */
export interface DunningDatabase {
  subscription_dunning: SubscriptionDunningTable;
}

/** Billing and dunning. */
export type DunningDb = BillingDb & DunningDatabase;
