/**
 * Table types of member slots (B031, migration 20260102001200_session_member_slots.sql). Written
 * by the slot store (`repos/session-slots.ts`); ids and integers only.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface SessionMemberSlotsTable {
  session_id: Fixed<string>;
  /** `mem_` id. */
  member_id: Fixed<string>;
  /** 0-49. */
  slot: Fixed<number>;
  assigned_at: CreatedAt;
}

/** The session_member_slots table. */
export interface SessionSlotsDatabase {
  session_member_slots: SessionMemberSlotsTable;
}

/** What the slot store reads and writes: the core tables and member slots. */
export type SessionSlotDatabase = CoreDatabase & SessionSlotsDatabase;
