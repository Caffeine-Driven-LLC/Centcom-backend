/**
 * Branch and conflict signalling ports and bounds (B061, CT-WS-SESSION-EVENTS `branch.update` and
 * `conflict.detected`).
 *
 * Owns: the shapes and bounds. Must not: carry anything from `ct` (branch names, heads, paths).
 */
import type { ErrorCode } from '@centcom/core';
import type { SessionRole } from '../rooms/kind-policy.js';
import type { StoredFrame } from '../seq/types.js';

/** Identical conflict signals within this window are one (card: 30 s). */
export const CONFLICT_DEDUPE_MS = 30_000;
/** Server conflict signals per session per second at most (failure mode: a burst of denials). */
export const SERVER_SIGNALS_PER_SECOND = 10;
/** `conflict.detected` lists at most this many agent ids or path hashes (schema `maxItems`). */
export const MAX_CONFLICT_ITEMS = 200;
/**
 * A path hash: CT-WS-SESSION-EVENTS' pattern, at most 64 characters (B059's lock store keys the
 * same hashes).
 */
export const PATH_HMAC = /^[A-Za-z0-9_-]{1,64}$/;

/** The session's agents (B057's registry). */
export interface AgentDirectoryPort {
  /** Every agent the session knows, with its owner (`mem_`) and whether it exited. */
  agents(sid: string): Promise<{ agentId: string; owner: string; exited: boolean }[]>;
}

/** Whether a member is connected to the session on any node (B051's markers). */
export interface ConnectedPort {
  isConnected(sid: string, memberId: string): Promise<boolean>;
}

/** The session's mode (B057's `SessionModePort`). */
export interface ModePort {
  modeOf(sid: string): Promise<'command_post' | 'branch'>;
}

/** Sequences the server's `conflict.detected` (from `srv`, `p` only). */
export interface ConflictEmitter {
  emit(sid: string, p: { agent_ids: string[]; path_hmacs: string[] }): Promise<void>;
}

/** Cluster-wide de-duplication windows and the server signal rate. */
export interface SignalGate {
  /** Marks `key` for `ms` (SET NX); true when this call marked it, else the value already there. */
  mark(key: string, value: string, ms: number): Promise<true | string>;
  /** Forgets `key` when it still holds `value`. */
  unmark(key: string, value: string): Promise<void>;
  /** Takes one of the session's server signals this second; false when the cap is reached. */
  take(sid: string): Promise<boolean>;
}

/** The sender of a frame. */
export interface SignalSender {
  memberId: string;
  role: SessionRole;
}

/** What the handlers get with a frame. */
export interface SignalContext {
  sid: string;
  sender: SignalSender;
  /**
   * Runs the rest of the pipeline: the stored frame once sequenced; `unknown` when the store
   * failed while assigning it (it may be stored, B041's SEQUENCE_UNKNOWN_KEY); undefined when it
   * was refused or was a resend.
   */
  sequence(): Promise<StoredFrame | 'unknown' | undefined>;
}

/** A frame: its id, cleartext `p` and `ct` (never opened). */
export interface SignalFrame {
  id: string;
  p?: unknown;
  ct?: unknown;
}

/** What a handler did with a frame. */
export type SignalResult =
  | { outcome: 'sequenced' }
  /** Sequencing refused it (the sequencer answered the sender). */
  | { outcome: 'ignored' }
  | { outcome: 'refused'; code: ErrorCode; detail: string };
