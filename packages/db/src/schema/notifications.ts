/**
 * Table types of notifications (B063, migration 20260102001400_notifications.sql). Written by the
 * notification store (`repos/notifications.ts`); keys, ids, enums and integers only.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface NotificationsTable {
  /** `ntf_` id. */
  id: Fixed<string>;
  user_id: Fixed<string>;
  /** The published event: one row per (user, event). */
  event_id: Fixed<string>;
  category: Fixed<string>;
  params: Fixed<Record<string, string | number>>;
  priority: Fixed<'low' | 'normal' | 'high'>;
  action: Fixed<{ type: string; deeplink?: string } | null>;
  channels: Fixed<string[]>;
  dedupe_key: Fixed<string | null>;
  digest_pending: ColumnType<boolean, boolean, boolean>;
  digest_sent_at: ColumnType<Date | null, never, Date>;
  created_at: CreatedAt;
  read_at: ColumnType<Date | null, never, Date | null>;
}

/** The notifications table. */
export interface NotificationsDatabase {
  notifications: NotificationsTable;
}

/** What the notification store reads and writes: the core tables and notifications. */
export type NotificationDb = CoreDatabase & NotificationsDatabase;
