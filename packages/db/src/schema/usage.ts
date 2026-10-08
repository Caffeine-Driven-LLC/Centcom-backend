/**
 * Table types of usage events (B074, migration 20260102002100_usage_events.sql). Written by the
 * usage repository (apps/api `modules/usage/repository.ts`), append-only.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface UsageEventTable {
  workspace_id: Fixed<string>;
  /** The client's `use_` id. */
  event_id: Fixed<string>;
  type: Fixed<'agent_minutes' | 'tokens_in' | 'tokens_out' | 'queue_items' | 'relay_bytes'>;
  /** bigint: read back as a string. */
  qty: ColumnType<string, number, never>;
  at: Fixed<Date>;
  session_id: Fixed<string | null>;
  agent_id: Fixed<string | null>;
  device_id: Fixed<string>;
  received_at: ColumnType<Date, Date | undefined, never>;
}

/** The usage tables. */
export interface UsageDatabase {
  usage_event: UsageEventTable;
}

/** The core tables and usage. */
export type UsageDb = CoreDatabase & UsageDatabase;

/** Counters per workspace, period and metric (B075, migration 20260102002200). */
export interface UsageCounterTable {
  workspace_id: string;
  period_start: Date;
  metric: string;
  /** bigint: read back as a string. */
  total: ColumnType<string, number, string | number>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** The 80 % and 100 % crossings of a period (B075). */
export interface QuotaStateTable {
  workspace_id: string;
  period_start: Date;
  limit_key: 'hosted_minutes_month' | 'queue_items_month';
  crossed_80_at: Date | null;
  crossed_100_at: Date | null;
}

/** How far the aggregator has read usage_event (B075). */
export interface UsageAggregateCursorTable {
  id: string;
  high_water: Date;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** The aggregation tables (B075). */
export interface UsageAggregationDatabase extends UsageDatabase {
  usage_counter: UsageCounterTable;
  quota_state: QuotaStateTable;
  usage_aggregate_cursor: UsageAggregateCursorTable;
}

/** The core tables, usage events and aggregation. */
export type UsageAggregationDb = CoreDatabase & UsageAggregationDatabase;
