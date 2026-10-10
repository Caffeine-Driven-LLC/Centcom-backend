/**
 * What starts a quota evaluation (B076), and the entitlements' `warnings[]`:
 *
 * - **Usage moved:** `withQuotaSignals(quota, enqueue)` wraps B075's `QuotaService` for the usage
 *   aggregator: after each workspace the aggregator touched has had its crossings checked, its
 *   `evaluate` job is queued (the worker's `enqueueQuotaEvaluate`, debounced 10 s per workspace).
 * - **Limits moved:** `subscribeEntitlementChanges(pubsub, enqueue)` queues an evaluation for each
 *   `{workspace, rev}` B069 announces, so a raised or lowered limit re-arms or signals without
 *   waiting for usage.
 * - **The sweep:** `sweepQuota` (the worker's `sweep` job, every 60 s) queues every candidate the
 *   store finds (meters that moved recently, deliveries still to do, periods that just ended), so
 *   a lost trigger is caught up within a minute.
 * - **`warnings[]`:** `quotaWarningsReader(inner, store)` keeps B075's usage numbers and takes the
 *   warnings from the stored signals of the period B069 asks about (so a re-armed level drops out),
 *   without calling back into B069.
 *
 * Owns: these hooks. Must not: evaluate in the caller's request (the job does).
 */
import type { Logger, PubSub, Unsubscribe } from '@centcom/core';
import { ENTITLEMENTS_INVALIDATE_CHANNEL, type UsageReaderPort } from '../../entitlements/ports.js';
import { periodOf } from '../../usage/period.js';
import type { QuotaService } from '../../usage/quota.js';
import type { QuotaSignalStore } from './store.js';

/** Queues a workspace's evaluation. */
export type EnqueueEvaluate = (workspaceId: string) => Promise<void>;

/** Workspaces one sweep page reads. */
export const SWEEP_BATCH = 500;

/** B075's quota service for the aggregator, queuing an evaluation after each crossing check. */
export function withQuotaSignals(
  quota: Pick<QuotaService, 'detectCrossings'>,
  enqueue: EnqueueEvaluate,
  logger?: Logger,
): Pick<QuotaService, 'detectCrossings'> {
  return {
    async detectCrossings(workspaceId, now) {
      try {
        return await quota.detectCrossings(workspaceId, now);
      } finally {
        // Queued whatever B075 found: the evaluation reads the counters itself.
        await enqueue(workspaceId).catch((err: unknown) =>
          logger?.warn(
            { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
            'quota.enqueue_failed',
          ),
        );
      }
    },
  };
}

/** Queues an evaluation for every workspace whose entitlements change (B069's announcements). */
export function subscribeEntitlementChanges(
  pubsub: Pick<PubSub, 'subscribe'>,
  enqueue: EnqueueEvaluate,
  logger?: Logger,
): Promise<Unsubscribe> {
  return pubsub.subscribe(ENTITLEMENTS_INVALIDATE_CHANNEL, (message) => {
    let workspaceId: unknown;
    try {
      workspaceId = (JSON.parse(message) as { workspace?: unknown }).workspace;
    } catch {
      return;
    }
    if (typeof workspaceId !== 'string' || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId))
      return;
    void enqueue(workspaceId).catch((err: unknown) =>
      logger?.warn(
        { workspace_id: workspaceId, error: err instanceof Error ? err.name : 'unknown' },
        'quota.enqueue_failed',
      ),
    );
  });
}

/** Queues every sweep candidate; resolves to how many were queued. */
export async function sweepQuota(deps: {
  store: Pick<QuotaSignalStore, 'sweepCandidates'>;
  enqueue: EnqueueEvaluate;
  now: Date;
  batch?: number;
}): Promise<number> {
  const batch = deps.batch ?? SWEEP_BATCH;
  let queued = 0;
  let after: string | null = null;
  for (;;) {
    const page = await deps.store.sweepCandidates(after, batch, deps.now);
    for (const workspaceId of page) {
      await deps.enqueue(workspaceId);
      queued += 1;
    }
    if (page.length < batch) return queued;
    after = page.at(-1) ?? null;
  }
}

/** B069's usage reader with `warnings[]` from the stored quota signals. */
export function quotaWarningsReader(
  inner: UsageReaderPort,
  store: Pick<QuotaSignalStore, 'levels'>,
  clock: () => number = Date.now,
): UsageReaderPort {
  return {
    async read(workspaceId, period) {
      const current = periodOf(new Date(clock()), period);
      const [report, levels] = await Promise.all([
        inner.read(workspaceId, period),
        store.levels(workspaceId, current.start),
      ]);
      const warnings = (['hosted_minutes_month', 'queue_items_month'] as const).flatMap((limit) => {
        const level = levels[limit];
        return level === undefined ? [] : [{ limit, pct: level === 'warn' ? 80 : 100 }];
      });
      return { ...report, warnings };
    },
  };
}
