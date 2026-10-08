/**
 * Table types of audit export jobs (B082, migration 20260102002400_audit_export_jobs.sql). Written
 * by the audit API (apps/api `modules/audit-api/repository.ts`) and its export worker.
 */
import type { ColumnType } from 'kysely';
import type { AuditDatabase } from '@centcom/core';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** The status of an export. */
export type AuditExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface AuditExportJobsTable {
  /** `exp_` id. */
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  /** The requester's `usr_` or `key_` id. */
  requested_by: Fixed<string>;
  format: Fixed<'csv' | 'json'>;
  gzip: ColumnType<boolean, boolean | undefined, never>;
  /** `{actor?, action?, from?, to?, since}`: the filters as given, and the retention horizon. */
  filters: ColumnType<Record<string, string>, string, never>;
  status: ColumnType<AuditExportStatus, AuditExportStatus | undefined, AuditExportStatus>;
  row_count: ColumnType<number | null, never, number | null>;
  object_key: ColumnType<string | null, never, string | null>;
  error: ColumnType<string | null, never, string | null>;
  created_at: CreatedAt;
  started_at: ColumnType<Date | null, never, Date | null>;
  completed_at: ColumnType<Date | null, never, Date | null>;
  expires_at: ColumnType<Date | null, never, Date | null>;
}

/** The export table. */
export interface AuditExportDatabase {
  audit_export_jobs: AuditExportJobsTable;
}

/** The core tables, the audit log and its exports. */
export type AuditApiDb = CoreDatabase & AuditDatabase & AuditExportDatabase;
