/**
 * Table types of staff access (B087, migration 20260102002900_staff_users.sql): who may call the
 * internal admin API and in which role, the reason and ticket of each staff call, and the column
 * a staff "disable" sets on `users`. Written and read by the API's admin module.
 */
import type { ColumnType } from 'kysely';
import type { AuditDatabase } from '@centcom/core';
import type { CoreDatabase, CreatedAt, NullableTimestamp, UpdatedAt, UsersTable } from './core.js';
import type { RefreshTokensDatabase } from './refresh-tokens.js';

/** A staff role, least to most. */
export type StaffRole = 'support_ro' | 'support_rw' | 'superadmin';

export interface StaffUsersTable {
  /** The staff member's `usr_` id. */
  user_id: ColumnType<string, string, never>;
  role: StaffRole;
  /** The superadmin who added or last changed the row; null for one an operator inserted. */
  added_by: string | null;
  added_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** Set when the row was disabled; a disabled row grants nothing. */
  disabled_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface StaffAuditDetailsTable {
  /** The `aud_` id of the call's audit event. */
  audit_id: ColumnType<string, string, never>;
  /** X-Admin-Reason (10-500 characters); null when the call was refused for lacking one. */
  reason: ColumnType<string | null, string | null, never>;
  /** X-Admin-Ticket (1-64 characters), if given. */
  ticket: ColumnType<string | null, string | null, never>;
  created_at: CreatedAt;
}

/** `users` with B087's column. */
export interface StaffUsersColumns extends UsersTable {
  /** When staff disabled the user's sign-in; null while it is allowed. */
  login_disabled_at: NullableTimestamp;
}

/** What the admin module reads and writes. */
export type AdminDatabase = Omit<CoreDatabase, 'users'> & {
  users: StaffUsersColumns;
  staff_users: StaffUsersTable;
  staff_audit_details: StaffAuditDetailsTable;
} & RefreshTokensDatabase &
  AuditDatabase;
