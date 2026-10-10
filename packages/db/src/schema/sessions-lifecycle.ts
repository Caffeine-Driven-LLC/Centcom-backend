/**
 * Table types of the session lifecycle (B053, migration 20260102004100_sessions_lifecycle.sql):
 * `sessions` with the columns the state machine adds, and `session_outbox`. The API's sessions
 * module writes them; the database it uses also reaches the host's member row and slot, the
 * session's policy (B051) and the workspace memberships.
 */
import type { ColumnType, Generated } from 'kysely';
import type { ControlTables } from './control.js';
import type {
  CoreDatabase,
  CreatedAt,
  NullableTimestamp,
  SessionsTable,
  UpdatedAt,
} from './core.js';
import type { SessionSlotsDatabase } from './session-slots.js';

/** `sessions`, with the lifecycle's columns. */
export interface LifecycleSessionsTable extends Omit<SessionsTable, 'state'> {
  state: ColumnType<
    'pending' | 'live' | 'paused' | 'ended' | 'expired',
    'pending' | 'live' | 'paused' | 'ended' | 'expired' | undefined,
    'pending' | 'live' | 'paused' | 'ended' | 'expired'
  >;
  host_member_id: ColumnType<string | null, string | null | undefined, string | null>;
  host_connected: ColumnType<boolean, boolean | undefined, boolean>;
  last_host_seen_at: ColumnType<Date, Date | string | undefined, Date | string>;
  paused_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  end_reason: ColumnType<
    'done' | 'abandoned' | 'error' | 'expired' | null,
    'done' | 'abandoned' | 'error' | 'expired' | null | undefined,
    'done' | 'abandoned' | 'error' | 'expired' | null
  >;
  updated_at: UpdatedAt;
}

/** `session_outbox`: a transition to deliver to the relay and as a domain event. */
export interface SessionOutboxTable {
  id: Generated<string>;
  session_id: ColumnType<string, string, never>;
  state: ColumnType<string, string, never>;
  event_type: ColumnType<
    'session.created' | 'session.started' | 'session.ended' | null,
    'session.created' | 'session.started' | 'session.ended' | null | undefined,
    never
  >;
  event_id: Generated<string>;
  relay_sent_at: NullableTimestamp;
  event_sent_at: NullableTimestamp;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  created_at: CreatedAt;
}

/** The lifecycle's tables. */
export interface SessionsLifecycleTables {
  sessions: LifecycleSessionsTable;
  session_outbox: SessionOutboxTable;
}

/** What the sessions module reads and writes. */
export type SessionsLifecycleDatabase = Omit<CoreDatabase, 'sessions'> &
  SessionsLifecycleTables &
  ControlTables &
  SessionSlotsDatabase;
