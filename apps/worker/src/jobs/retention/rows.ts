/**
 * Row retention (B090): a policy for a table whose rows are due by a rule on their own columns
 * (expired tokens, old deliveries, read notifications...), deleted ROW_BATCH at a time.
 *
 * The store says how many rows are due at `now` and how many the table holds, and deletes up to a
 * batch of due rows, oldest first; the rule itself (the cutoff, the statuses) lives in the store's
 * SQL. The policy checks the fraction brake first (unless the table is one whose rows live minutes
 * by design, `guard: false`), then deletes batch after batch until none is due or the budget is
 * spent.
 *
 * Owns: the loop. Must not: know the tables.
 */
import {
  deadlineOf,
  guardFraction,
  outOfTime,
  ROW_BATCH,
  type RetentionContext,
  type RetentionPolicy,
  type RetentionResult,
} from './policy.js';

/** A table's due rows, by a rule of the store's. */
export interface RowRetentionStore {
  /** Rows due at `now`, and every row of the table. */
  count(now: Date): Promise<{ due: number; total: number }>;
  /** Deletes up to `limit` rows due at `now`, oldest first; how many it deleted. */
  purge(now: Date, limit: number): Promise<number>;
}

/** What a row policy is made of. */
export interface RowPolicyOptions {
  id: string;
  owner: string;
  store: RowRetentionStore;
  /** Apply the fraction brake (default true; false for tables whose rows live minutes). */
  guard?: boolean;
  /** Rows per delete (default ROW_BATCH). */
  batch?: number;
}

/** A policy deleting a table's due rows. */
export function createRowPolicy(options: RowPolicyOptions): RetentionPolicy {
  const batch = options.batch ?? ROW_BATCH;
  return {
    id: options.id,
    owner: options.owner,
    async run(ctx: RetentionContext): Promise<RetentionResult> {
      const deadline = deadlineOf(ctx, ctx.clock());
      const { due, total } = await options.store.count(ctx.now);
      if (options.guard !== false) guardFraction(ctx, due, total);
      if (ctx.dryRun || due === 0) return { scanned: due, purged: 0, skipped: 0 };
      let purged = 0;
      for (;;) {
        if (outOfTime(ctx, deadline)) {
          return {
            scanned: due,
            purged,
            skipped: 0,
            backlog: Math.max(0, due - purged),
            stopped: 'budget_exceeded',
          };
        }
        const deleted = await options.store.purge(ctx.now, batch);
        purged += deleted;
        if (deleted < batch) return { scanned: due, purged, skipped: 0 };
      }
    },
  };
}
