/**
 * Table types of account deletion and data exports (B026, migration
 * 20260102003300_account_lifecycle.sql). Written by the API's account-lifecycle module and the
 * `account-export` and `account-purge` jobs.
 */
import type { ColumnType } from 'kysely';
import type { AuditDatabase } from '@centcom/core';
import type { CoreDatabase, CreatedAt, NullableTimestamp, UpdatedAt, UsersTable } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** The status of a data export (`running` shows as `pending` on the wire). */
export type AccountExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

/** `users` with B026's columns. */
export interface LifecycleUsersTable extends UsersTable {
  /** When the purge may run: the request plus 30 days; null when no deletion is pending. */
  deletion_scheduled_at: NullableTimestamp;
  /** When the purge scrubbed the row (kept only while other people's records point at it). */
  deleted_at: NullableTimestamp;
}

/** `account_exports`: one row per data export request. */
export interface AccountExportsTable {
  /** `exp_` id. */
  id: Fixed<string>;
  user_id: Fixed<string>;
  status: ColumnType<AccountExportStatus, AccountExportStatus | undefined, AccountExportStatus>;
  /** `exports/<usr>/<exp>.json` once written. */
  blob_key: ColumnType<string | null, string | null | undefined, string | null>;
  /** `bigint`: pg returns it as a string. */
  size_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  error_code: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  expires_at: NullableTimestamp;
}

/** The B026 tables, over the core schema and the audit log. */
export type AccountLifecycleDatabase = Omit<CoreDatabase, 'users'> &
  AuditDatabase & {
    users: LifecycleUsersTable;
    account_exports: AccountExportsTable;
  };
