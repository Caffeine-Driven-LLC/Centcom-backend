/**
 * Table types of the session control state (B051, migration 20260102003900_session_control.sql).
 * Written by the relay's control module; the policy is read by the queue service (B052).
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, UpdatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;
/** A column with a default, writable later. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

/** `session_policy`: a session's policy (CT-WS-CONTROL `control.policy`). */
export interface SessionPolicyTable {
  session_id: Fixed<string>;
  auto_approve: Defaulted<'ask' | 'trusted' | 'everyone'>;
  share_history: Defaulted<boolean>;
  queue_limit: Defaulted<number>;
  locked: Defaulted<boolean>;
  auto_failover: Defaulted<boolean>;
  /** `mem_` ids. */
  trusted: Defaulted<string[]>;
  approvers: Defaulted<string[]>;
  queue_paused: Defaulted<boolean>;
  /** `bigint`: pg returns it as a string. Null while the frame is being sequenced. */
  updated_seq: ColumnType<string | null, number | null | undefined, number | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `session_mute`: a muted member, until `until` (null: until unmuted). */
export interface SessionMuteTable {
  session_id: Fixed<string>;
  member_id: Fixed<string>;
  until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The control tables. */
export interface ControlTables {
  session_policy: SessionPolicyTable;
  session_mute: SessionMuteTable;
}

/** The core tables and the control tables. */
export type ControlDatabase = CoreDatabase & ControlTables;
