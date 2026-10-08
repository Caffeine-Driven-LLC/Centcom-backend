/**
 * The usage aggregator (B075): folds usage_event rows and the relay's counters into usage_counter,
 * then looks for new quota crossings.
 *
 * 1. **Events:** in one transaction holding the cursor (counters.ts), the rows received after the
 *    high-water mark and at least SETTLE_MS ago are summed by workspace, type and second. Each sum
 *    goes to the counter of the period it happened in: a late event counts in its own, earlier
 *    period. The mark moves to the end of the window in the same transaction, so a crash or a
 *    rerun never counts a row twice. Rows still being written (B074's insert runs within the
 *    10 s statement timeout) are left for a later run by SETTLE_MS.
 * 2. **The relay:** each workspace with pending relay counts (`RelayCounterPort`) has its hosted
 *    minutes, queue items and relay bytes taken and added to its current period. If the relay
 *    cannot be reached, client metrics still aggregate; the relay's are skipped, counted
 *    (`usage_relay_unavailable_total`) and taken next run.
 * 3. **Crossings:** every workspace touched is checked (`QuotaService.detectCrossings`). One whose
 *    check failed (a bump that failed, say) is checked again next run.
 *
 * Runs every USAGE_AGGREGATE_EVERY_MS (the worker's `usage.aggregate` schedule), so usage shows in
 * quotas within SETTLE_MS + USAGE_AGGREGATE_EVERY_MS (45 s).
 *
 * Owns: the steps above. Must not: change or delete raw usage_event rows.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { CounterDelta, CounterMetric, CounterStore } from './counters.js';
import { periodOf, type UsagePeriod } from './period.js';
import type { QuotaService } from './quota.js';

/** How often the worker runs the aggregator. */
export const USAGE_AGGREGATE_EVERY_MS = 15_000;
/** Rows received less than this long ago wait for a later run (their insert may not be visible yet). */
export const SETTLE_MS = 30_000;

/** The relay's server-side meters (the relay lifecycle and queue services). */
export type RelayMetric = 'hosted_minutes' | 'queue_items' | 'relay_bytes';

/** The relay's counters: what accumulated since the last take. */
export interface RelayCounterPort {
  /** Workspaces with counts waiting. */
  workspaces(): Promise<string[]>;
  /** Takes (and resets) the count of `metric` waiting for `workspaceId`. */
  take(workspaceId: string, metric: RelayMetric): Promise<number>;
}

/** The counter a relay meter goes to. */
export const RELAY_METRICS: Readonly<Record<RelayMetric, CounterMetric>> = Object.freeze({
  hosted_minutes: 'relay.hosted_minutes',
  queue_items: 'relay.queue_items',
  relay_bytes: 'relay.relay_bytes',
});

/** A workspace's subscribed period (B069's entitlements `period`), or null for calendar months. */
export interface PeriodSource {
  period(workspaceId: string): Promise<UsagePeriod | null>;
}

/** What the aggregator needs. */
export interface UsageAggregatorDeps {
  counters: CounterStore;
  periods: PeriodSource;
  relay?: RelayCounterPort;
  quota?: Pick<QuotaService, 'detectCrossings'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** What a run did. */
export interface AggregateResult {
  /** Workspaces whose counters changed. */
  workspaces: number;
  /** usage_event rows folded. */
  events: number;
}

/** The aggregator. */
export class UsageAggregator {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  /** Workspaces whose crossing check failed, checked again next run. */
  readonly #recheck = new Set<string>();

  constructor(private readonly deps: UsageAggregatorDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** One run at `now` (idempotent: a second run over the same rows changes nothing). */
  async run(now: Date = new Date(this.#clock())): Promise<AggregateResult> {
    const touched = new Set<string>();
    const upTo = new Date(now.getTime() - SETTLE_MS);
    const events = await this.deps.counters.aggregate(async (tx) => {
      const highWater = await tx.highWater();
      if (upTo.getTime() <= highWater.getTime()) return 0;
      const sums = await tx.eventSums(highWater, upTo);
      const periods = new Map<string, UsagePeriod | null>();
      for (const workspaceId of new Set(sums.map((s) => s.workspaceId))) {
        periods.set(workspaceId, await this.deps.periods.period(workspaceId));
      }
      const deltas: CounterDelta[] = sums.map((s) => ({
        workspaceId: s.workspaceId,
        periodStart: periodOf(s.second, periods.get(s.workspaceId) ?? null).start,
        metric: s.type,
        amount: s.total,
      }));
      await tx.add(deltas);
      await tx.setHighWater(upTo);
      for (const s of sums) touched.add(s.workspaceId);
      return sums.reduce((n, s) => n + s.events, 0);
    });
    this.#metrics.counter('usage_events_aggregated_total').inc(events);

    await this.#takeRelay(now, touched);

    for (const workspaceId of this.#recheck) touched.add(workspaceId);
    this.#recheck.clear();
    if (this.deps.quota !== undefined) {
      for (const workspaceId of touched) {
        try {
          await this.deps.quota.detectCrossings(workspaceId, now);
        } catch (err) {
          this.#recheck.add(workspaceId);
          this.deps.logger?.warn(
            { workspace_id: workspaceId, error: (err as Error).name },
            'usage.crossing_check_failed',
          );
        }
      }
    }
    return { workspaces: touched.size, events };
  }

  /** Adds the relay's waiting counts to each workspace's current period. */
  async #takeRelay(now: Date, touched: Set<string>): Promise<void> {
    const { relay } = this.deps;
    if (relay === undefined) return;
    let workspaces: string[];
    try {
      workspaces = await relay.workspaces();
    } catch (err) {
      this.#relayUnavailable(err);
      return;
    }
    for (const workspaceId of workspaces) {
      try {
        const period = periodOf(now, await this.deps.periods.period(workspaceId));
        const deltas: CounterDelta[] = [];
        for (const metric of Object.keys(RELAY_METRICS) as RelayMetric[]) {
          const amount = await relay.take(workspaceId, metric);
          if (amount > 0) {
            deltas.push({
              workspaceId,
              periodStart: period.start,
              metric: RELAY_METRICS[metric],
              amount,
            });
          }
        }
        if (deltas.length > 0) {
          await this.deps.counters.add(deltas);
          touched.add(workspaceId);
        }
      } catch (err) {
        this.#relayUnavailable(err);
      }
    }
  }

  #relayUnavailable(err: unknown): void {
    this.#metrics.counter('usage_relay_unavailable_total').inc();
    this.deps.logger?.warn({ error: (err as Error).name }, 'usage.relay_unavailable');
  }
}
