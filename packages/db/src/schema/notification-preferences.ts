/**
 * Table types of notification preferences (B066, migration
 * 20260102001900_notification_preferences.sql). Written by the preferences repository (apps/api
 * `modules/notifications/preferences/repository.ts`): one validated document per user.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase } from './core.js';

export interface NotificationPrefTable {
  user_id: ColumnType<string, string, never>;
  /** The preference document (CT-API-NOTIFY `NotificationPreferences`), at most 8 KiB. */
  doc: ColumnType<Record<string, unknown>, string, string>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  /** 1 on insert, one more on every write; the ETag's version. */
  version: ColumnType<number, number | undefined, number>;
}

/** The notification preferences table. */
export interface NotificationPrefDatabase {
  notification_pref: NotificationPrefTable;
}

/** The core tables and notification preferences. */
export type NotificationPrefDb = CoreDatabase & NotificationPrefDatabase;
