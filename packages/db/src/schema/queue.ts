/**
 * Table types of the command-post queue (B052, migration 20260102004000_queue_items.sql). Written
 * by the relay's queue module; never a body.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, UpdatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;
/** A column with a default, writable later. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;
/** `bigint`: pg returns it as a string. */
type Counter = ColumnType<string, number | undefined, number>;

/** `queue_session`: a session's queue version, host flag and last applied frame. */
export interface QueueSessionTable {
  session_id: Fixed<string>;
  version: Counter;
  host_away: Defaulted<boolean>;
  updated_seq: Counter;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `queue_item`: one queue item's clear metadata. */
export interface QueueItemTable {
  session_id: Fixed<string>;
  item_id: Fixed<string>;
  /** `mem_`. */
  submitter: Fixed<string>;
  state: string;
  held_from: 'approved' | 'running' | null;
  position: number | null;
  size: Fixed<number>;
  kind: Fixed<'message' | 'command'>;
  /** `agt_`. */
  agent_id: string | null;
  ts: ColumnType<Date, Date | string, Date | string>;
  created_seq: ColumnType<string, number, number>;
  updated_seq: ColumnType<string, number, number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The queue tables. */
export interface QueueTables {
  queue_session: QueueSessionTable;
  queue_item: QueueItemTable;
}

/** The core tables and the queue tables. */
export type QueueDatabase = CoreDatabase & QueueTables;
