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
