/**
 * Quota state (B075, CT-ENTITLEMENTS §5): how much of each metered limit a workspace has used this
 * period, its 80 % and 100 % crossings, and whether B080 may let a hosted action through.
 *
 * - **Meters** are server-measured only: `hosted_minutes_month` is the relay's
 *   `relay.hosted_minutes`, `queue_items_month` its `relay.queue_items`. Client-reported metrics
 *   (`agent_minutes`, `tokens_in`, `tokens_out`, `relay_bytes`) are never compared with a limit.
 * - **Limits** come from the entitlements (B069), authoritative. `null` is unlimited: pct null,
 *   never exceeded, never a crossing. `0` allows nothing: used 0 is pct 0, any use is pct 100 and
 *   exceeded. Otherwise pct = floor(used × 100 / limit) and exceeded = used ≥ limit.
 * - **Warnings** list each limit at 80 % or more, with pct 80 or 100.
 * - **Crossings:** each (workspace, limit, period) crosses 80 and 100 at most once. A crossing is
 *   claimed in quota_state together with B069's `bumpRev` (if the bump fails, nothing is marked and
 *   the next check tries again), then `QuotaCrossed {workspace, limit, pct, resets_at}` goes to
 *   B076.
 * - **Period:** the entitlements' period when subscribed, else the UTC calendar month.
 *
 * Owns: these rules. Must not: read Stripe or plan names, or count LAN or local usage.
 */
import { noopMetrics, notFound, type Logger, type Metrics, type PubSub } from '@centcom/core';
import type { CounterMetric, CounterStore, QuotaKey } from './counters.js';
import { periodOf, type UsagePeriod } from './period.js';

/** The metered limits, in CT-ENTITLEMENTS order. */
export const QUOTA_KEYS: readonly QuotaKey[] = Object.freeze([
  'hosted_minutes_month',
  'queue_items_month',
]);

/** The counter metering each limit. */
export const QUOTA_METERS: Readonly<Record<QuotaKey, CounterMetric>> = Object.freeze({
  hosted_minutes_month: 'relay.hosted_minutes',
  queue_items_month: 'relay.queue_items',
});

/** The thresholds that warn. */
export const THRESHOLDS = Object.freeze([80, 100] as const);

/** The channel QuotaCrossed events go out on (B076 listens). */
export const QUOTA_CROSSED_CHANNEL = 'quota:crossed';

/** One limit's state. */
export interface QuotaItem {
  key: QuotaKey;
  used: number;
  limit: number | null;
  pct: number | null;
  exceeded: boolean;
}

/** A workspace's quota state for a period. */
export interface QuotaState {
  period: UsagePeriod;
  items: QuotaItem[];
  warnings: { limit: QuotaKey; pct: 80 | 100 }[];
}

/** A crossing, for B076. */
export interface QuotaCrossed {
  workspace: string;
  limit: QuotaKey;
  pct: 80 | 100;
  /** When the period ends and the counter starts again (ISO 8601). */
  resets_at: string;
}

/** What quotas read from the entitlements (B069's `EntitlementService.get`). */
export interface EntitlementsReader {
  get(workspaceId: string): Promise<{
    limits: Partial<Record<QuotaKey, number | null>> & Record<string, unknown>;
    period?: { start: string; end: string };
  } | null>;
}

/** B069's `bumpRev`. */
export interface RevBumper {
  bumpRev(workspaceId: string, reason: 'usage_warning'): Promise<number>;
}

/** Where crossings go (B076). */
export interface QuotaEventsPort {
  emit(event: QuotaCrossed): Promise<void>;
}

/** Crossings as JSON on `quota:crossed`. */
export const pubsubQuotaEvents = (pubsub: Pick<PubSub, 'publish'>): QuotaEventsPort => ({
  emit: (event) => pubsub.publish(QUOTA_CROSSED_CHANNEL, JSON.stringify(event)),
});

/** One limit's state from its use and limit. */
export function quotaItem(key: QuotaKey, used: number, limit: number | null): QuotaItem {
  if (limit === null) return { key, used, limit, pct: null, exceeded: false };
  if (limit === 0) return { key, used, limit, pct: used > 0 ? 100 : 0, exceeded: used > 0 };
  return { key, used, limit, pct: Math.floor((used * 100) / limit), exceeded: used >= limit };
}

/** The warning of an item, if it is at 80 % or more. */
export function warningOf(item: QuotaItem): { limit: QuotaKey; pct: 80 | 100 } | null {
  if (item.pct === null || item.pct < 80) return null;
  return { limit: item.key, pct: item.pct >= 100 ? 100 : 80 };
}

/** The entitlements' period as dates, or null when not subscribed. */
export function subscribedPeriod(
  period: { start: string; end: string } | undefined,
): UsagePeriod | null {
  return period === undefined ? null : { start: new Date(period.start), end: new Date(period.end) };
}

/** What the quota service needs. */
export interface QuotaServiceDeps {
  counters: CounterStore;
  entitlements: EntitlementsReader;
  rev: RevBumper;
  events?: QuotaEventsPort;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Quotas: state, checks for B080, crossings. */
export class QuotaService {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: QuotaServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The workspace's quota state at `now`; 404 for a workspace without entitlements. */
  async compute(workspaceId: string, now: Date = new Date(this.#clock())): Promise<QuotaState> {
    const ent = await this.deps.entitlements.get(workspaceId);
    if (ent === null) throw notFound('There is no such workspace.');
    const period = periodOf(now, subscribedPeriod(ent.period));
    const totals = await this.deps.counters.totals(workspaceId, period.start);
    const items = QUOTA_KEYS.map((key) => {
      const limit = ent.limits[key];
      return quotaItem(
        key,
        totals[QUOTA_METERS[key]] ?? 0,
        typeof limit === 'number' ? limit : null,
      );
    });
    const warnings = items.flatMap((item) => {
      const warning = warningOf(item);
      return warning === null ? [] : [warning];
    });
    return { period, items, warnings };
  }

  /** Whether a hosted action metered by `key` may go ahead, and when to retry if not. */
  async check(
    workspaceId: string,
    key: QuotaKey,
    now: Date = new Date(this.#clock()),
  ): Promise<{ allowed: boolean; retryAfterS: number | null }> {
    const state = await this.compute(workspaceId, now);
    const item = state.items.find((i) => i.key === key);
    if (item === undefined || !item.exceeded) return { allowed: true, retryAfterS: null };
    const seconds = Math.ceil((state.period.end.getTime() - now.getTime()) / 1000);
    return { allowed: false, retryAfterS: Math.max(1, seconds) };
  }

  /** Claims and announces the crossings the workspace has reached and not yet had this period. */
  async detectCrossings(
    workspaceId: string,
    now: Date = new Date(this.#clock()),
  ): Promise<QuotaCrossed[]> {
    const state = await this.compute(workspaceId, now);
    const crossed: QuotaCrossed[] = [];
    for (const item of state.items) {
      for (const pct of THRESHOLDS) {
        if (item.pct === null || item.pct < pct) continue;
        const claimed = await this.deps.counters.claimCrossing(
          workspaceId,
          state.period.start,
          item.key,
          pct,
          now,
          async () => {
            await this.deps.rev.bumpRev(workspaceId, 'usage_warning');
          },
        );
        if (!claimed) continue;
        const event: QuotaCrossed = {
          workspace: workspaceId,
          limit: item.key,
          pct,
          resets_at: state.period.end.toISOString(),
        };
        crossed.push(event);
        this.#metrics.counter('quota_crossings_total', { limit: item.key, pct: String(pct) }).inc();
        try {
          await this.deps.events?.emit(event);
        } catch (err) {
          this.deps.logger?.warn(
            { workspace_id: workspaceId, limit: item.key, pct, error: (err as Error).name },
            'usage.quota_event_failed',
          );
        }
      }
    }
    return crossed;
  }
}
