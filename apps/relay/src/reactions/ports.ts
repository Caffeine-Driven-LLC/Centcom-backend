/**
 * Reaction and comment ports and bounds (B062, CT-WS-SESSION-EVENTS `reaction` and
 * `comment.add`).
 *
 * Owns: the shapes and bounds. Must not: carry a comment's text or target (inside `ct`).
 */

/** CT-WS-SESSION-EVENTS `reaction.code`. */
export const REACTION_CODES = Object.freeze([
  'thumbs',
  'heart',
  'party',
  'laugh',
  'eyes',
  'check',
] as const);
export type ReactionCode = (typeof REACTION_CODES)[number];

/** A frame id (`msg_`), the only target a reaction may name. */
export const TARGET = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Reaction ops a member may send per minute (card limit). */
export const REACTION_OPS_PER_MINUTE = 200;

/** A sequenced reaction. */
export interface ReactionOp {
  seq: number;
  /** The sender (`mem_`). */
  from: string;
  target: string;
  code: ReactionCode;
  op: 'add' | 'remove';
}

/** Per target, per code: how many members hold that reaction now. */
export type ReactionCounts = Record<string, Partial<Record<ReactionCode, number>>>;

/** Reactions as a per-target set (Postgres `reaction`). */
export interface ReactionStore {
  /**
   * Applies a sequenced reaction: an add holds it, a remove drops it, for the sender only. A
   * frame older than the one that set the current state changes nothing (so frames applied out
   * of order, or replayed, end in the state of the highest seq). `changed` when the live set
   * changed.
   */
  apply(sid: string, op: ReactionOp): Promise<{ changed: boolean }>;
  /** The live reactions of `targets`, counted per code (targets without any are left out). */
  aggregate(sid: string, targets: readonly string[]): Promise<ReactionCounts>;
  /** Rebuilds from the log (the repair after failed writes): applies every reaction it is given. */
  rebuild(sid: string, ops: Iterable<ReactionOp> | AsyncIterable<ReactionOp>): Promise<number>;
  /** Removes every reaction of the session (B055's history purge). */
  purge(sid: string): Promise<number>;
}

/** A sequenced comment's pointer: where it is in the log, never what it says. */
export interface CommentRef {
  seq: number;
  /** The frame id (`msg_`). */
  id: string;
  /** The sender (`mem_`). */
  from: string;
  /** Bytes of the serialised `ct`. */
  size: number;
  /** `ct.kid`. */
  kid: string;
}

/** Comment pointers (Postgres `comment_ref`). */
export interface CommentIndex {
  /** Records a sequenced comment; a frame already recorded changes nothing. */
  record(sid: string, c: CommentRef): Promise<void>;
  /** Removes every pointer of the session (B055's history purge). */
  purge(sid: string): Promise<number>;
}
