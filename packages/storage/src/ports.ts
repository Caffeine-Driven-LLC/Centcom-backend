/**
 * The history store's types and ports (B055, CT-RESUME).
 *
 * - `StoredFrame`: one sequenced frame as the durable log keeps it. Besides the card's fields
 *   (seq, id, from, ts, kind class, size, kid, `ct`, `p`) it keeps the envelope's `k` and `sig`,
 *   because CT-API-SESSIONS' `HistoryFrame` returns them: a client verifies the signature and
 *   applies the frame by kind. It also keeps `ref` (an id, never content), so the relay's replay
 *   from the log (B042) sends the frame exactly as it was first delivered. Only the index fields reach Postgres; the rest lives in the blob.
 * - `HistoryAccess`: who the caller is in a session (the session role, workspace ownership, and
 *   whether the session shares its history with share-link guests). Postgres answers for users;
 *   share-link guests come with B068.
 *
 * Owns: the types. Must not: describe a field the contract does not let the server keep.
 */

/** CT-CRYPTO's ciphertext object, kept byte for byte. */
export interface CtObject {
  alg: string;
  kid: string;
  n: string;
  c: string;
}

/** The frame types the durable log keeps (never `presence` or `sys.*`). */
export type KindClass = 'event' | 'queue' | 'control';

/** One frame of the durable log. */
export interface StoredFrame {
  seq: number;
  /** The frame id (`msg_`, `que_`, ...). */
  id: string;
  /** The sender: a `mem_` id, or `srv` for frames the relay emits. */
  from: string;
  /** RFC 3339, as the relay stamped it. */
  ts: string;
  kindClass: KindClass;
  /** The id of the frame this one answers (`ref`), when it has one (B042's replay). */
  ref?: string;
  /** The kind (`k`), when the frame has one. */
  k?: string;
  /** Bytes of the frame as stored (set by the store). */
  size: number;
  kid: string | null;
  ct: CtObject | null;
  /** The cleartext part, for clear kinds and the contract's clear fields of hybrid kinds. */
  p: Record<string, unknown> | null;
  /** The sender's Ed25519 signature (base64url). */
  sig?: string;
}

/** One page of history. */
export interface HistoryRead {
  /** Contiguous frames from the first one after `afterSeq`. */
  frames: StoredFrame[];
  /** The last returned seq when more contiguous frames follow, else null. */
  nextAfterSeq: number | null;
  /** The earliest retained frame (CT-RESUME's `from_seq`); null when there is none. */
  earliestSeq: number | null;
  /** The highest stored frame; null when there is none. */
  headSeq: number | null;
}

/** The durable log of sessions. */
export interface HistoryStore {
  /** Stores `frames` of session `sid`: blob first, then the index; idempotent on (sid, seq). */
  append(sid: string, frames: readonly StoredFrame[]): Promise<{ lastSeq: number }>;
  /** Up to `limit` contiguous frames after `afterSeq`. A blob that cannot be read throws. */
  read(sid: string, afterSeq: number, limit: number): Promise<HistoryRead>;
  /** Deletes the session's blobs, then its index rows; resumable. */
  purge(sid: string): Promise<{ deleted: number; blobs: number }>;
  /** When the session's history may be purged (`history_days` after its end). */
  setExpiry(sid: string, at: Date): Promise<void>;
}

/** A caller's place in a session, as `HistoryAccess` reports it. */
export interface SessionStanding {
  /** The session's workspace; null for a session outside any workspace. */
  workspaceId: string | null;
  /** The caller's live session role; null when they are not a participant. */
  role: 'host' | 'editor' | 'viewer' | null;
  /** True when the caller owns the session's workspace. */
  workspaceOwner: boolean;
  /** True when the caller is a share-link guest (B068: a viewer with a limited token). */
  shareLinkGuest: boolean;
  /** The session's "share history" policy (CT-WS-CONTROL `control.policy.share_history`). */
  shareHistory: boolean;
}

/** Who the caller is in a session. */
export interface HistoryAccess {
  /** The caller's standing in session `sid`; null when the session does not exist. */
  standing(sid: string, caller: { userId: string }): Promise<SessionStanding | null>;
}
