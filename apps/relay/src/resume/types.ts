/**
 * Resume types (B042, CT-RESUME): the ports the replay reads behind the hot buffer, and what a
 * resume decided.
 *
 * - `DurableLogReader`: the durable log (B055's history store, `durable-log.ts`), read when the hot
 *   buffer no longer has a frame, and for hydration after the store lost a session.
 * - `SnapshotLookup`: the session's latest snapshot (B056). Until B056 there is none, and
 *   CT-RESUME says `snapshot_required` is then never sent: the relay replays what it still has.
 *
 * Owns: these interfaces. Must not: describe anything the relay could read inside `ct`.
 */
import type { StoredFrame } from '../seq/types.js';

/** The durable log behind the hot buffer. */
export interface DurableLogReader {
  /**
   * Up to `limit` frames after `afterSeq` in `seq` order, as they were first delivered: from the
   * earliest retained frame when older ones are gone, and stopping at a gap.
   */
  range(sid: string, afterSeq: number, limit: number): Promise<StoredFrame[]>;
  /** The newest durable `seq` of the session; 0 when it has none. */
  maxSeq(sid: string): Promise<number>;
}

/** The session's snapshots (B056). */
export interface SnapshotLookup {
  /** The `seq` of the latest committed snapshot, or null when there is none. */
  latestSeq(sid: string): Promise<number | null>;
}

/** No durable log (a relay without object storage): only the hot buffer is replayed. */
export const noDurableLog: DurableLogReader = Object.freeze({
  range: () => Promise.resolve([]),
  maxSeq: () => Promise.resolve(0),
});

/** No snapshots (until B056). */
export const noSnapshots: SnapshotLookup = Object.freeze({
  latestSeq: () => Promise.resolve(null),
});

/** What a resume decided and did. */
export interface ResumeResult {
  /** `none`: a fresh join, nothing replayed. */
  mode: 'none' | 'replayed' | 'snapshot_required';
  /** Replayed: the first `seq` sent (or `toSeq + 1` when none was). */
  fromSeq?: number;
  /** Replayed: the last `seq` sent (or the client's `last_seq` when none was). */
  toSeq?: number;
  count?: number;
  /** Replayed: some frames after the client's `last_seq` are no longer available. */
  historyGap?: boolean;
  /** Snapshot required: the snapshot to start from. */
  snapshotSeq?: number;
}
