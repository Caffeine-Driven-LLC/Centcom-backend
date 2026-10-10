/**
 * Table types of quota signals (B076, migration 20260102004500_quota_signal_state.sql). Written by
 * the API's quota signal store (apps/api `modules/billing/quota/`): which 80 % and 100 % signals
 * each workspace, metered limit and period has had, under which limit, and how far their delivery
 * has got. Ids, enums, limits and times only.
 */
import type { ColumnType } from 'kysely';
import type { CreatedAt } from './core.js';
import type { UsageAggregationDb } from './usage.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** `quota_signal_state`: one row per (workspace, limit, period, level) signalled. */
export interface QuotaSignalStateTable {
  workspace_id: Fixed<string>;
  limit_key: Fixed<'hosted_minutes_month' | 'queue_items_month'>;
  period_start: Fixed<Date>;
  level: Fixed<'warn' | 'reached'>;
  period_end: Fixed<Date>;
  /** The limit the level was claimed under (`bigint`: read as a string). */
  limit_value: ColumnType<string, number, never>;
  claimed_at: CreatedAt;
  /** When the relay's `sys.notice` was published. */
  fired_at: ColumnType<Date | null, never, Date>;
  /** When the owners' notification was requested. */
  notified_at: ColumnType<Date | null, never, Date>;
  /** When the `usage.threshold` webhook event was queued. */
  webhook_at: ColumnType<Date | null, never, Date>;
}

/** The quota signal tables. */
export interface QuotaSignalsDatabase {
  quota_signal_state: QuotaSignalStateTable;
}

/** The core tables, usage aggregation and quota signals. */
export type QuotaSignalsDb = UsageAggregationDb & QuotaSignalsDatabase;
