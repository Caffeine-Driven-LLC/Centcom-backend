/**
 * Snapshot pruning (B056, CT-RESUME "Keeps the latest 3; deletes older ones").
 *
 * - **Keep 3** (`pruneSession`, after each commit): the latest snapshot (highest seq, the one GET
 *   serves) and the 2 most recently committed others are kept; older commits are deleted. So a
 *   lower seq committed now is stored, and the only committed snapshot is never deleted.
 * - **Expired uploads**: pending rows older than 15 min, and their objects if any were uploaded
 *   (`pruneSession` for its session after each commit, `prune` for all). A younger upload is
 *   untouched.
 * - **Order:** a row is marked `deleting` first (GET never serves it again), then its object is
 *   deleted, then the row. A prune that stops after the object went leaves the row `deleting`; the
 *   next prune (`prune` retries every such row) finishes it. Deleting an object that is already
 *   gone is not an error, so every step can be repeated.
 * - Every pass is bounded (PRUNE_BATCH rows per kind) and idempotent.
 *
 * Owns: what goes and in which order. Must not: delete the only committed snapshot, or a row
 * before its object.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  KEEP_COMMITTED,
  PENDING_TTL_MS,
  type SnapshotObjects,
  type SnapshotRow,
  type SnapshotRows,
} from './ports.js';

/** Rows handled per kind in one `prune`. */
export const PRUNE_BATCH = 100;
/** Passes `purgeSession` makes before it gives up on rows that keep appearing. */
export const PURGE_PASSES = 3;

/** Why rows were deleted (the `reason` label of `snapshot_pruned_total`). */
export type PruneReason = 'beyond_newest' | 'expired_pending' | 'retried' | 'purged';

/** What pruning needs. */
export interface PruneDeps {
  rows: SnapshotRows;
  objects: Pick<SnapshotObjects, 'delete' | 'list'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Counts of one `prune`. */
export interface PruneResult {
  expired: number;
  retried: number;
}

/** Deletes snapshot objects and rows, in the safe order. */
export class SnapshotPruner {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: PruneDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /**
   * Deletes the objects of `rows` (already `deleting`), then the rows. Rejects when the store
   * fails; the rows then stay `deleting` for the next prune.
   */
  async #finish(rows: readonly SnapshotRow[], reason: PruneReason): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      await this.deps.objects.delete(rows.map((r) => r.blobKey));
      await this.deps.rows.remove(rows.map((r) => r.snp));
    } catch (err) {
      this.#metrics.counter('snapshot_prune_failures_total').inc();
      this.deps.logger?.warn(
        { reason, rows: rows.length, error: err instanceof Error ? err.name : 'unknown' },
        'snapshot.prune_incomplete',
      );
      throw err;
    }
    this.#metrics.counter('snapshot_pruned_total', { reason }).inc(rows.length);
    return rows.length;
  }

  /** Marks `rows` (in `from`) as `deleting` and deletes those this call marked. */
  async #delete(
    rows: readonly SnapshotRow[],
    from: SnapshotRow['state'],
    reason: PruneReason,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const marked = new Set(
      await this.deps.rows.markDeleting(
        rows.map((r) => r.snp),
        from,
      ),
    );
    return this.#finish(
      rows.filter((r) => marked.has(r.snp)),
      reason,
    );
  }

  /**
   * Keeps KEEP_COMMITTED committed snapshots of `sid`, expires its uploads pending over 15 min and
   * finishes its deletions that stopped halfway; resolves to how many rows went.
   */
  async pruneSession(sid: string): Promise<number> {
    const beyond = await this.deps.rows.beyondNewest(sid, KEEP_COMMITTED);
    let gone = await this.#delete(beyond, 'committed', 'beyond_newest');
    const before = new Date(this.#clock() - PENDING_TTL_MS);
    const stale = await this.deps.rows.expiredPending(before, PRUNE_BATCH, sid);
    gone += await this.#delete(stale, 'pending', 'expired_pending');
    const halfway = await this.deps.rows.deleting(PRUNE_BATCH, sid);
    gone += await this.#finish(halfway, 'retried');
    return gone;
  }

  /**
   * Deletes uploads pending for more than 15 min, and finishes deletions that stopped halfway.
   * Safe to run from any number of instances at once.
   */
  async prune(): Promise<PruneResult> {
    const before = new Date(this.#clock() - PENDING_TTL_MS);
    const stale = await this.deps.rows.expiredPending(before, PRUNE_BATCH);
    const expired = await this.#delete(stale, 'pending', 'expired_pending');
    const halfway = await this.deps.rows.deleting(PRUNE_BATCH);
    const retried = await this.#finish(halfway, 'retried');
    return { expired, retried };
  }

  /**
   * Deletes every snapshot of `sid` (B090's retention and workspace purge): every row is marked
   * `deleting`, then the objects under the session's prefix (uploads never committed included),
   * then the rows. Repeating it after a failure finishes the job.
   */
  async purgeSession(sid: string, prefix: string): Promise<number> {
    let gone = 0;
    // A begin or commit racing the purge adds or changes rows: pass again until none are left.
    for (let pass = 0; pass < PURGE_PASSES; pass++) {
      const rows = await this.deps.rows.allOf(sid);
      if (rows.length === 0 && pass > 0) return gone;
      for (const state of ['pending', 'committed'] as const) {
        await this.deps.rows.markDeleting(
          rows.filter((r) => r.state === state).map((r) => r.snp),
          state,
        );
      }
      const all = await this.deps.rows.deleting(Number.MAX_SAFE_INTEGER, sid);
      gone += await this.#finish(all, 'purged');
      const left = await this.deps.objects.list(prefix);
      try {
        if (left.length > 0) await this.deps.objects.delete(left);
      } catch (err) {
        this.#metrics.counter('snapshot_prune_failures_total').inc();
        throw err;
      }
    }
    if ((await this.deps.rows.allOf(sid)).length > 0) {
      throw new Error('snapshot purge did not finish; run it again');
    }
    return gone;
  }
}
