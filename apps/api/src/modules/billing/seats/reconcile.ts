/**
 * The daily seat reconciliation (B073, worker job `billing.seats.reconcile`): every Team workspace
 * with a subscription in effect, in batches of RECONCILE_BATCH by workspace id, through
 * `SeatService.reconcile` (Stripe's seats against the stored ones and the seats in use; a drift is
 * stored, a mismatch logged). One workspace's failure (Stripe down for it, a bad row) is counted
 * and the run goes on; the run reports how many it checked, repaired and failed.
 *
 * Owns: the run over workspaces and its source query. Must not: change seats on Stripe (only the
 * stored copy follows Stripe).
 */
import type { BillingDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { SeatService } from './service.js';

/** Workspaces one batch reads. */
export const RECONCILE_BATCH = 200;

/** Where the run finds Team workspaces. */
export interface ReconcileSource {
  /** Up to `limit` Team workspaces in effect, by id, after `after` (null: from the start). */
  teamWorkspaces(after: string | null, limit: number): Promise<string[]>;
}

/** What one run came to. */
export interface ReconcileRun {
  checked: number;
  repaired: number;
  failed: number;
}

/** The source on Postgres (B070's `billing_subscription`). */
export function createReconcileSource<DB extends BillingDb>(database: Kysely<DB>): ReconcileSource {
  const db = database as unknown as Kysely<BillingDb>;
  return {
    async teamWorkspaces(after, limit) {
      let query = db
        .selectFrom('billing_subscription')
        .select('workspace_id')
        .where('plan', '=', 'team')
        .where('status', 'in', ['active', 'trialing', 'past_due']);
      if (after !== null) query = query.where('workspace_id', '>', after);
      const rows = await query.orderBy('workspace_id').limit(limit).execute();
      return rows.map((r) => r.workspace_id);
    },
  };
}

/** Reconciles every Team workspace (see the module comment). */
export async function reconcileAll(deps: {
  source: ReconcileSource;
  seats: Pick<SeatService, 'reconcile'>;
  logger?: Logger;
  metrics?: Metrics;
}): Promise<ReconcileRun> {
  const run: ReconcileRun = { checked: 0, repaired: 0, failed: 0 };
  let after: string | null = null;
  for (;;) {
    const batch = await deps.source.teamWorkspaces(after, RECONCILE_BATCH);
    for (const workspaceId of batch) {
      try {
        const result = await deps.seats.reconcile(workspaceId);
        run.checked += 1;
        if (result.repaired) run.repaired += 1;
      } catch (err) {
        run.failed += 1;
        (deps.metrics ?? noopMetrics)
          .counter('billing_seat_reconciles_total', { outcome: 'failed' })
          .inc();
        deps.logger?.warn(
          { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
          'billing.seats_reconcile_failed',
        );
      }
    }
    if (batch.length < RECONCILE_BATCH) break;
    after = batch.at(-1) ?? null;
  }
  return run;
}
