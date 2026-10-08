/**
 * Table types of the durable history index (B055, migration 20260102003400_history_index.sql).
 * Written by the API's history module; the frames themselves are in the object store.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, UpdatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** `history_index`: where one frame of a session's durable log is. */
export interface HistoryIndexTable {
  session_id: Fixed<string>;
  /** `bigint`: pg returns it as a string. */
  seq: ColumnType<string, number, never>;
  msg_id: Fixed<string>;
  /** `mem_` or `srv`. */
  member_id: Fixed<string>;
  ts: ColumnType<Date, Date | string, never>;
  kind_class: Fixed<'event' | 'queue' | 'control'>;
  size: Fixed<number>;
  kid: Fixed<string | null>;
  blob_key: Fixed<string>;
}

/** `history_retention`: when a session's history may be purged. */
export interface HistoryRetentionTable {
  session_id: Fixed<string>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The history tables. */
export interface HistoryTables {
  history_index: HistoryIndexTable;
  history_retention: HistoryRetentionTable;
}

/** The core tables and the history tables. */
export type HistoryDatabase = CoreDatabase & HistoryTables;
