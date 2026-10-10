/**
 * Table types of data retention (B090, migration 20260102004200_retention.sql), and the database
 * the retention repository works on: its own tables plus every table a retention policy deletes
 * from or reads to decide. Ids, counts, enums and times only.
 */
import type { AuditDatabase } from '@centcom/core';
import type { ColumnType } from 'kysely';
import type { AccountExportsTable } from './account-lifecycle.js';
import type { AuditExportDatabase } from './audit-exports.js';
import type { CoreDatabase, CreatedAt, UpdatedAt } from './core.js';
import type { DeviceGrantsDatabase } from './device-grants.js';
import type { HistoryTables } from './history.js';
import type { InvitesDatabase } from './invites.js';
import type { LoginTokensDatabase } from './login-tokens.js';
import type { NotificationsDatabase } from './notifications.js';
import type { PromotionsDatabase } from './promotions.js';
import type { RefreshTokensDatabase } from './refresh-tokens.js';
import type { StaffAuditDetailsTable } from './staff.js';
import type { StripeEventsDatabase } from './stripe-events.js';
import type { WebhookDatabase } from './webhooks.js';
import type { WorkspaceSettingsDatabase } from './workspace-settings.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** Why a policy's run stopped before the end. */
export type RetentionAbortReason =
  'fraction_exceeded' | 'budget_exceeded' | 'failed' | 'interrupted';

/** `retention_runs`: one policy's run. */
export interface RetentionRunsTable {
  /** `bigint` identity: pg returns it as a string. */
  id: ColumnType<string, never, never>;
  policy: Fixed<string>;
  started_at: ColumnType<Date, Date | undefined, never>;
  finished_at: ColumnType<Date | null, never, Date>;
  /** `bigint` counts: read as strings. */
  scanned: ColumnType<string, never, number>;
  purged: ColumnType<string, never, number>;
  skipped: ColumnType<string, never, number>;
  dry_run: Fixed<boolean>;
  aborted_reason: ColumnType<RetentionAbortReason | null, never, RetentionAbortReason | null>;
}

/** The datasets whose retention follows the workspace's plan. */
export type RetentionDataset = 'history' | 'audit';

/** `retention_baseline`: the days the job enforces for a workspace's dataset. */
export interface RetentionBaselineTable {
  workspace_id: Fixed<string>;
  dataset: Fixed<RetentionDataset>;
  days: ColumnType<number, number, number>;
  updated_at: UpdatedAt;
}

/** `retention_pending`: a shortened retention recorded and not in effect yet. */
export interface RetentionPendingTable {
  workspace_id: Fixed<string>;
  dataset: Fixed<RetentionDataset>;
  old_days: ColumnType<number, number, number>;
  new_days: ColumnType<number, number, number>;
  notice_sent_at: ColumnType<Date | null, never, Date | null>;
  email_sent_at: ColumnType<Date | null, never, Date | null>;
  effective_at: ColumnType<Date, Date, Date>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The retention tables. */
export interface RetentionTables {
  retention_runs: RetentionRunsTable;
  retention_baseline: RetentionBaselineTable;
  retention_pending: RetentionPendingTable;
}

/** Every table the retention repository reads or deletes from. */
export type RetentionDb = CoreDatabase &
  RetentionTables &
  HistoryTables &
  WorkspaceSettingsDatabase &
  AuditDatabase &
  AuditExportDatabase &
  WebhookDatabase &
  NotificationsDatabase &
  RefreshTokensDatabase &
  LoginTokensDatabase &
  DeviceGrantsDatabase &
  InvitesDatabase &
  StripeEventsDatabase &
  PromotionsDatabase & {
    account_exports: AccountExportsTable;
    staff_audit_details: StaffAuditDetailsTable;
  };
