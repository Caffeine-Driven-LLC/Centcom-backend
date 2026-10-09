/**
 * Table types of Stripe webhook ingestion and the billing outbox (B072, migration
 * 20260102003500_stripe_events.sql). Written by the API's `billing/webhooks` module.
 */
import type { ColumnType, Generated } from 'kysely';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** Where a Stripe event is in its processing. */
export type StripeEventStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored';

/** `stripe_event`: one row per Stripe event id. */
export interface StripeEventTable {
  event_id: Fixed<string>;
  type: Fixed<string>;
  created_at_stripe: ColumnType<Date, Date | string, never>;
  /** The reduced object (ids, status, amounts, currency); never card data. */
  payload: ColumnType<Record<string, unknown>, string, never>;
  status: ColumnType<StripeEventStatus, StripeEventStatus | undefined, StripeEventStatus>;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  received_at: ColumnType<Date, Date | string | undefined, never>;
  processed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** `billing_outbox`: domain events to publish (outgoing webhooks, notification requests). */
export interface BillingOutboxTable {
  id: Generated<string>;
  type: Fixed<string>;
  workspace_id: Fixed<string>;
  payload: ColumnType<Record<string, unknown>, string, never>;
  dedupe_key: Fixed<string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  published_at: ColumnType<Date | null, never, Date | string | null>;
}

/** The webhook tables. */
export interface StripeEventsDatabase {
  stripe_event: StripeEventTable;
  billing_outbox: BillingOutboxTable;
}
