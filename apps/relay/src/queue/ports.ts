/**
 * The queue lane's ports (B052): what the queue service needs from the rest of the relay, so it
 * runs against in-memory fakes in tests and against Postgres, B041/B044 and B051 in the relay.
 *
 * - `QueueStore`: the session's queue, durable and locked. `withSession` runs `fn` holding the
 *   session's lock (Postgres: a transaction with the `queue_session` row `FOR UPDATE`), so queue
 *   changes are serialised on every node; what `fn` saved is committed when it returns and
 *   discarded when it throws.
 * - `PolicyReader`: B051's session policy (`ctx.control.policies`).
 * - `QueueSequencer`: the relay's own `queue.state` frames (B044's `emitServer`), the sequenced
 *   frames after a `seq` (catch-up after a crash), and re-sending a stored frame to one connection
 *   (a resubmitted item's original `seq`).
 *
 * Owns: the port types. Must not: hold an implementation.
 */
import type { RelayConnection } from '../pipeline.js';
import type { StoredFrame } from '../seq/types.js';
import type { QueueItem, QueueModel, QueueStateBody } from './state-machine.js';

/** What the queue reads of the session's policy (B051's SessionPolicy has all of it). */
export interface QueuePolicy {
  auto_approve: 'ask' | 'trusted' | 'everyone';
  /** `mem_` ids auto-approved under `trusted`. */
  trusted: string[];
  queue_limit: number;
  locked: boolean;
  queue_paused: boolean;
}

/** The session's policy. */
export interface PolicyReader {
  get(sid: string): Promise<QueuePolicy>;
}

/** A session's queue as stored. */
export interface PersistedQueue {
  version: number;
  hostAway: boolean;
  /** The last frame applied to these rows. */
  updatedSeq: number;
  order: string[];
  items: QueueItem[];
}

/** The session's queue, under its lock. */
export interface QueueTx {
  /** The stored queue; null for a session that never had one. */
  load(): Promise<PersistedQueue | null>;
  /** Stores `model` (the session row, and the items in `changed` or in the order). */
  save(model: QueueModel, changed: readonly string[], updatedSeq: number): Promise<void>;
}

/** Where queues are kept. */
export interface QueueStore {
  withSession<T>(sid: string, fn: (tx: QueueTx) => Promise<T>): Promise<T>;
}

/** The sequencing the queue needs beyond its own frames. */
export interface QueueSequencer {
  /** Sequences and delivers `queue.state` from `srv`. */
  emitState(sid: string, body: QueueStateBody): Promise<StoredFrame>;
  /** The session's sequenced frames after `afterSeq`, oldest first (as far as the buffer goes). */
  framesAfter(sid: string, afterSeq: number): Promise<StoredFrame[]>;
  /** Sends the stored frame at `seq` to `conn` again (an echo); false when it is not buffered. */
  resend(conn: RelayConnection, sid: string, seq: number): Promise<boolean>;
}
