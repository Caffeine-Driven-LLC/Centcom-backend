/**
 * Table types of presence history (B067, migration 20260102004900_presence_history.sql): when a
 * member came online and went offline in a session, and when it was last seen. Connection facts
 * only, never a presence payload (status, activity, cursor).
 */
import type { ColumnType, Generated } from 'kysely';
import type { CoreDatabase } from './core.js';

/** One online/offline event. */
export interface PresenceLogTable {
  id: Generated<string>;
  session_id: ColumnType<string, string, never>;
  member_id: ColumnType<string, string, never>;
  device_id: ColumnType<string | null, string | null, never>;
  event: ColumnType<'connected' | 'disconnected', 'connected' | 'disconnected', never>;
  reason: ColumnType<
    'closed' | 'timeout' | 'kicked' | null,
    'closed' | 'timeout' | 'kicked' | null,
    never
  >;
  at: ColumnType<Date, Date, never>;
}

/** A member's last sighting in a session. */
export interface MemberLastSeenTable {
  session_id: ColumnType<string, string, never>;
  member_id: ColumnType<string, string, never>;
  device_id: string | null;
  last_seen_at: Date;
  connected: boolean;
}

/** The presence history tables. */
export interface PresenceHistoryTables {
  presence_log: PresenceLogTable;
  member_last_seen: MemberLastSeenTable;
}

/** The core tables with the presence history's. */
export type PresenceHistoryDatabase = CoreDatabase & PresenceHistoryTables;
