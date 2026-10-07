/**
 * The `audit_events` table as Kysely sees it (B036, migration 20260102000600_audit_events.sql).
 * Every column's update type is `never`: rows are append-only, and the table's trigger refuses
 * UPDATE, DELETE and TRUNCATE (retention purges through `purge_audit_events` only).
 */
import type { ColumnType } from 'kysely';
import type { AuditActorType, AuditMetaValue, AuditOutcome } from './event.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface AuditEventsTable {
  /** `aud_` ULID, made by the emitter. */
  id: Fixed<string>;
  /** `wsp_` id; null for events outside any workspace. */
  workspace_id: Fixed<string | null>;
  actor_type: Fixed<AuditActorType>;
  /** `usr_`, `key_` or `dev_` id, or a service name for `system`. */
  actor_id: Fixed<string>;
  /** A catalogue action (`member.role_change`). */
  action: Fixed<string>;
  target_type: Fixed<string | null>;
  /** A CT-IDS id of any entity. */
  target_id: Fixed<string | null>;
  outcome: Fixed<AuditOutcome>;
  /** `req_` id of the request, when there was one. */
  request_id: Fixed<string | null>;
  /** Allowlisted ids and enums; written as JSON text, read as an object. */
  meta: ColumnType<Record<string, AuditMetaValue>, string, never>;
  /** When the event happened (the emitter's clock), not when its batch was written. */
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** The audit_events table. */
export interface AuditDatabase {
  audit_events: AuditEventsTable;
}

/** A row as the emitter inserts it. */
export interface NewAuditRow {
  id: string;
  workspace_id: string | null;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  request_id: string | null;
  meta: string;
  created_at: Date;
}
