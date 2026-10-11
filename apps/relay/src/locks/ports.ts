/**
 * The file-lock service's ports (B059, CT-WS-SESSION-EVENTS `file.lock`): the limits, the stored
 * shapes, and what the service needs from the rest of the relay, so it runs against fakes in tests
 * and against Redis, B041's sequencing and B044's fan-out in the relay.
 *
 * The service arbitrates on `path_hmac` (BLAKE2b-MAC of the path under the session's path key,
 * computed by clients) only; the path itself stays inside `ct` and never reaches these types.
 *
 * Owns: the shapes and limits. Must not: describe anything from `ct`.
 */
import type { SessionRole } from '../rooms/kind-policy.js';
import type { StoredFrame, UnsequencedFrame } from '../seq/types.js';

/**
 * TTL of a lock (CT-WS-SESSION-EVENTS "Limits": file.lock.ttl_ms, default 300 000; min 5 000;
 * max 3 600 000; the relay clamps). The card's 60 000 / 1 000 / 600 000 differ; the contract wins.
 */
export const LOCK_TTL_DEFAULT_MS = 300_000;
export const LOCK_TTL_MIN_MS = 5_000;
export const LOCK_TTL_MAX_MS = 3_600_000;
/** Waiters per path (card scope). */
export const MAX_WAITERS = 10;
/** Locks held per session and per agent (card scope). */
export const MAX_LOCKS_PER_SESSION = 500;
export const MAX_LOCKS_PER_AGENT = 100;
/** A `path_hmac` (card acceptance 7; the schema's pattern, at most 64 characters). */
export const PATH_HMAC = /^[A-Za-z0-9_-]{1,64}$/;

/** The TTL `ttl` asks for, clamped (absent: the default). */
export function clampTtl(ttl: unknown): number {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return LOCK_TTL_DEFAULT_MS;
  return Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, Math.round(ttl)));
}

/** A held lock. */
export interface HeldLock {
  /** The holding agent (`agt_`). */
  agent: string;
  /** The member who acquired it (`mem_`). */
  member: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  ttlMs: number;
}

/** A waiter for a path. */
export interface Waiter {
  agent: string;
  member: string;
  ttlMs: number;
  /** The acquire frame that queued it (a resend does not queue twice). */
  frameId: string;
  /** When it was queued (milliseconds), for `relay_lock_wait_ms`. */
  queuedAt: number;
}

/** A session's locks and waiters, by `path_hmac`, and where its members are connected. */
export interface SessionLocks {
  locks: Map<string, HeldLock>;
  queues: Map<string, Waiter[]>;
  /** Member (`mem_`) to the relay nodes it has a connection on (cluster-wide, for leaves). */
  members: Map<string, string[]>;
  /**
   * Member to the mark of its latest departure from every node; only that departure's grace may
   * free its locks (an earlier one's timer finds a newer mark, or none after a rejoin).
   */
  departed: Map<string, string>;
}

/** How long a member gone from every node keeps its locks (CT-WS-SESSION-EVENTS: 10 s grace). */
export const LEAVE_GRACE_MS = 10_000;

/** A session's locks, under its lock (`LockStore.withSession`). */
export interface LockTx {
  load(): Promise<SessionLocks>;
  /** Stores the session's locks (and each held lock's own key with its TTL). */
  save(state: SessionLocks): Promise<void>;
}

/** Where locks are kept. */
export interface LockStore {
  /** Runs `fn` holding session `sid`'s lock; rejects (503) when Redis cannot be reached. */
  withSession<T>(sid: string, fn: (tx: LockTx) => Promise<T>): Promise<T>;
}

/** A client's `file.lock` frame as the service reads it: ids and the cleartext `p` only. */
export interface FileLockFrameIn {
  id: string;
  p: unknown;
}

/** Who sent it (from the room, never from the frame). */
export interface LockSender {
  memberId: string;
  role: SessionRole;
}

/** What the service needs to sequence frames. */
export interface LockContext {
  sid: string;
  sender: LockSender;
  /**
   * Sequences the client's frame (the rest of the pipeline) with `companions` (server frames) in
   * the same batch; undefined when sequencing refused it.
   */
  sequence(companions: UnsequencedFrame[]): Promise<StoredFrame | undefined>;
}

/** Server frames the service emits outside a client frame (deny, sweep, cleanup). */
export interface LockEmitter {
  emit(sid: string, frames: readonly Record<string, unknown>[]): Promise<void>;
}

/** Tells B061 who holds a path when an acquire is refused (a conflict hint). */
export interface ConflictHintPort {
  denied(sid: string, hint: { pathHmac: string; holder: string; requester: string }): void;
}

/** What became of a frame. */
export type LockOutcome =
  | { outcome: 'granted' }
  | { outcome: 'denied'; holder: string | null; reason: DenyReason }
  | { outcome: 'queued'; position: number }
  | { outcome: 'released' }
  | { outcome: 'ignored' }
  | {
      outcome: 'refused';
      code: 'invalid_frame' | 'forbidden' | 'service_unavailable';
      detail: string;
    };

/** Why an acquire was denied (`relay_lock_denials_total{reason}`). */
export type DenyReason = 'held' | 'queue_full' | 'session_cap' | 'agent_cap';
