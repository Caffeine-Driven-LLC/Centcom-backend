/**
 * Table types of reactions and comment pointers (B062, migration
 * 20260102005400_reactions_comments.sql). Written by the relay's reactions module from sequenced
 * frames; a reaction is cleartext (target, code), a comment only a pointer (seq, frame id, size,
 * key id), never its text or target (both inside `ct`).
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase } from './core.js';

/** `bigint`: pg returns it as a string. */
type Seq = ColumnType<string, number, number>;

/** One member's reaction (or its removal) to one frame. */
export interface ReactionTable {
  session_id: ColumnType<string, string, never>;
  /** The frame reacted to (`msg_`). */
  target: ColumnType<string, string, never>;
  code: ColumnType<
    'thumbs' | 'heart' | 'party' | 'laugh' | 'eyes' | 'check',
    'thumbs' | 'heart' | 'party' | 'laugh' | 'eyes' | 'check',
    never
  >;
  member_id: ColumnType<string, string, never>;
  /** The seq of the frame that set the current state. */
  seq: Seq;
  /** A remove keeps the row at its seq (so an older add applied later changes nothing). */
  removed: boolean;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** Where one comment is in the session's log. */
export interface CommentRefTable {
  session_id: ColumnType<string, string, never>;
  seq: ColumnType<string, number, never>;
  msg_id: ColumnType<string, string, never>;
  member_id: ColumnType<string, string, never>;
  /** Bytes of the serialised `ct`. */
  size: ColumnType<number, number, never>;
  /** The `ct.kid` it is encrypted with. */
  kid: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** The reaction and comment tables. */
export interface ReactionTables {
  reaction: ReactionTable;
  comment_ref: CommentRefTable;
}

/** The core tables with the reaction and comment tables. */
export type ReactionsDatabase = CoreDatabase & ReactionTables;
