/**
 * Presence history ports and bounds (B067, CT-WS-PRESENCE): connection facts only, never a
 * presence payload.
 *
 * Owns: the shapes and bounds.
 */

/** Why a member went offline. */
export type DisconnectReason = 'closed' | 'timeout' | 'kicked';

/** A member came online in a session (its first connection after being offline). */
export interface ConnectedEvent {
  sid: string;
  memberId: string;
  /** `dev_`; null for a share-link guest (no registered device). */
  deviceId: string | null;
  at: Date;
}

/** A member went offline (its last connection closed and stayed closed for the grace). */
export interface DisconnectedEvent extends ConnectedEvent {
  reason: DisconnectReason;
}

/** What the recorder hands the writer: online/offline events and last-seen touches, in order. */
export type HistoryEvent =
  | ({ kind: 'connected' } & ConnectedEvent)
  | ({ kind: 'disconnected' } & DisconnectedEvent)
  | ({ kind: 'touch' } & ConnectedEvent);

/** Writes a batch of events (Postgres); rejects when nothing was written. */
export interface PresenceHistoryWriter {
  write(events: readonly HistoryEvent[]): Promise<void>;
}

/** The lookups other backend lanes use (admin, search, members listing). Never a route. */
export interface PresenceHistory {
  /**
   * When `memberId` was last seen in `sid`: the start of the current minute while it is connected,
   * the time its latest connection closed otherwise, null when it never connected.
   */
  lastSeen(sid: string, memberId: string): Promise<Date | null>;
  /** The sessions `deviceId` was last seen in, newest first, only those it still belongs to. */
  recentSessions(deviceId: string, limit: number): Promise<{ sid: string; lastSeen: Date }[]>;
  /** Deletes log rows older than `cutoff` (B090 schedules it, 30 days); how many. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

/** A connection's last-seen touch is written at most this often. */
export const TOUCH_EVERY_MS = 60_000;
/** The recorder flushes this often, or at this many events. */
export const FLUSH_EVERY_MS = 1_000;
export const FLUSH_AT_EVENTS = 200;
/** Events kept while the database is down; past it the oldest go (counted). */
export const MAX_BUFFERED_EVENTS = 10_000;
/** `presence_log` rows are kept this long (CT-WS-PRESENCE; PII minimisation). */
export const LOG_RETENTION_MS = 30 * 86_400_000;
/** `recentSessions` returns at most this many. */
export const MAX_RECENT_SESSIONS = 50;
/** A `connected` row older than this no longer counts as online (a crashed node's members). */
export const ONLINE_STALE_MS = 3 * TOUCH_EVERY_MS;
