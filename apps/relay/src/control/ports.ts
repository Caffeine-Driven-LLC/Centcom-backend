/**
 * The control lane's ports (B051): what `handleControlFrame` needs from the rest of the relay, so
 * the handler runs against in-memory fakes in tests and against Postgres, B041/B044/B049 and B045
 * in the relay (`module.ts`).
 *
 * - `MembershipPort`: the session's member records (`session_members`), read fresh, and the
 *   writes a control frame makes to them (remove, role, host transfer), each conditional on the
 *   state the handler checked, so a concurrent change makes the write a no-op instead of a wrong
 *   one.
 * - `SessionStatePort`: ending the session (B053 owns the rest of the lifecycle).
 * - `SequencerPort`: server frames (`from: srv`) in the session's `seq` space, and the kick's
 *   `member_left` + `rotate_key` pair with consecutive `seq`s (B049's `rotate`, which uses B041's
 *   `assignBatch`).
 * - `ConnectionRegistryPort`: whether a member is connected anywhere, and closing a member's or a
 *   session's connections on every node (B045's member control).
 *
 * Owns: the port types. Must not: hold an implementation (those are in `memory.ts`,
 * `postgres.ts` and `module.ts`).
 */
import type { SessionRole } from '../rooms/kind-policy.js';
import type { LiveMember } from '../rooms/membership.js';

/** A session state (`sessions.state`). */
export type SessionState = 'pending' | 'live' | 'paused' | 'ended' | 'expired';

/** The session's member records. */
export interface MembershipPort {
  /** Member `mid` of `sid` as the records say now (no cache); null when not a current member. */
  get(sid: string, mid: string): Promise<LiveMember | null>;
  /**
   * Marks `mid` as having left at `at` (a kick: reconnects are refused 4403). False when it was
   * not a current, non-host member (nothing changed).
   */
  remove(sid: string, mid: string, at: Date): Promise<boolean>;
  /** Undoes `remove` (the kick's follow-up frames could not be sequenced). */
  restore(sid: string, mid: string): Promise<void>;
  /** Sets a current non-host member's role; false when `mid` is not one (nothing changed). */
  setRole(sid: string, mid: string, role: Exclude<SessionRole, 'host'>): Promise<boolean>;
  /**
   * Atomically: `from` (the host) becomes an editor and `to` (an editor) the host. False when
   * either is no longer in that role (nothing changed).
   */
  transferHost(sid: string, from: string, to: string): Promise<boolean>;
  /** The current members' ids (to close their connections when the session ends). */
  members(sid: string): Promise<string[]>;
}

/** The session's lifecycle state (B053 owns the state machine; the control lane only ends it). */
export interface SessionStatePort {
  /** Ends the session at `at`; its previous state, or null when it had already ended or expired. */
  end(sid: string, at: Date): Promise<SessionState | null>;
  /** Undoes `end` (the `session_state` frame could not be sequenced). */
  restore(sid: string, previous: SessionState): Promise<void>;
}

/** A frame the relay emits itself. */
export interface ServerFrame {
  kind: string;
  t: 'control';
  p: Record<string, unknown>;
}

/** Server frames in the session's `seq` space. */
export interface SequencerPort {
  /** Sequences and delivers `frame` from `srv`; its `seq`. */
  emit(sid: string, frame: ServerFrame): Promise<number>;
  /**
   * The kick's pair: `memberLeft` then `control.rotate_key {kid, reason: member_removed}`, with
   * consecutive `seq`s and nothing between them.
   */
  emitWithRotation(sid: string, memberLeft: ServerFrame): Promise<{ seqs: number[]; kid: string }>;
}

/** Connections, on every node. */
export interface ConnectionRegistryPort {
  /** True when `mid` has a connection to `sid` on any node. */
  isConnected(sid: string, mid: string): Promise<boolean>;
  /** Closes every connection of `mid` with `code` (and its `sys.error`, for 4403). */
  closeMember(sid: string, mid: string, code: number): Promise<void>;
  /** This node's cached view of `mid` changed (role, removal): read it again now. */
  refresh(sid: string, mid: string): Promise<void>;
}
