/**
 * Usage for readers (B075): B069's `UsageReaderPort`, and the usage summary.
 *
 * - `createUsageReader` fills the entitlements object's `usage` (`hosted_minutes_month`,
 *   `queue_items_month` from the relay's meters) and `warnings` (the period's crossings in
 *   quota_state: pct 100 once crossed, else 80). It reads stored state only, never the limits, so
 *   B069 can call it while building the entitlements. `usage.seats` comes from B030's
 *   `withSeatUsage` around it (seats in use, never Stripe's quantity).
 * - `UsageSummaryService.summary` answers `GET /v1/workspaces/{id}/usage/summary` in
 *   CT-API-USAGE's `UsageSummary` shape:
 *   - `{workspace, period, items}`;
 *   - items `agent_minutes`, `tokens`, `queue_items`, `relay_bytes`, `seats`, each with `used`,
 *     `limit` and `pct`;
 *   - additively, the card's `usage`, `limits` and `warnings`, which carry `hosted_minutes_month`
 *     (the contract's item list has no hosted-minutes metric).
 *
 * Usage is best effort (≤ 60 s behind); enforcement reads `QuotaService.check`.
 *
 * Owns: the read shapes. Must not: expose another workspace's usage.
 */
import type { Api } from '@centcom/contracts';
import type { Period, UsageReaderPort } from '../entitlements/ports.js';
import type { CounterStore } from './counters.js';
import { periodOf } from './period.js';
import { QUOTA_METERS, type QuotaService } from './quota.js';

/** Seats in use (B030's `SeatService.usage`). */
export interface SeatUsagePort {
  usage(workspaceId: string): Promise<{ members: number }>;
}

/** The entitlements object's usage and warnings from the counters and quota_state. */
export function createUsageReader(
  counters: CounterStore,
  clock: () => number = Date.now,
): UsageReaderPort {
  return {
    async read(workspaceId: string, period: Period | null) {
      const current = periodOf(new Date(clock()), period);
      const [totals, crossings] = await Promise.all([
        counters.totals(workspaceId, current.start),
        counters.crossings(workspaceId, current.start),
      ]);
      const warnings = crossings.flatMap((c) =>
        c.crossed100At !== null
          ? [{ limit: c.limitKey, pct: 100 }]
          : c.crossed80At !== null
            ? [{ limit: c.limitKey, pct: 80 }]
            : [],
      );
      return {
        usage: {
          hosted_minutes_month: totals[QUOTA_METERS.hosted_minutes_month] ?? 0,
          queue_items_month: totals[QUOTA_METERS.queue_items_month] ?? 0,
        },
        warnings,
      };
    },
  };
}

/** `UsageSummary` with the card's additive fields. */
export type UsageSummaryBody = Api.UsageSummary & {
  usage: { hosted_minutes_month: number; queue_items_month: number; seats: number };
  limits: {
    hosted_minutes_month: number | null;
    queue_items_month: number | null;
    max_seats: number | null;
  };
  warnings: { limit: string; pct: 80 | 100 }[];
};

const pctOf = (used: number, limit: number | null): number | null =>
  limit === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : Math.floor((used * 100) / limit);

/** What the summary needs. */
export interface UsageSummaryDeps {
  counters: CounterStore;
  quota: Pick<QuotaService, 'compute'>;
  seats: SeatUsagePort;
  /** For `max_seats`; B069's `EntitlementService.get`. */
  entitlements: {
    get(workspaceId: string): Promise<{ limits: { max_seats: number | null } } | null>;
  };
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** The usage summary. */
export class UsageSummaryService {
  readonly #clock: () => number;

  constructor(private readonly deps: UsageSummaryDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  /** The workspace's summary for its current period. */
  async summary(workspaceId: string): Promise<UsageSummaryBody> {
    const now = new Date(this.#clock());
    const state = await this.deps.quota.compute(workspaceId, now);
    const [totals, seats, ent] = await Promise.all([
      this.deps.counters.totals(workspaceId, state.period.start),
      this.deps.seats.usage(workspaceId),
      this.deps.entitlements.get(workspaceId),
    ]);
    const hosted = state.items.find((i) => i.key === 'hosted_minutes_month');
    const queue = state.items.find((i) => i.key === 'queue_items_month');
    const maxSeats = ent?.limits.max_seats ?? null;
    const queueUsed = queue?.used ?? 0;
    const queueLimit = queue?.limit ?? null;
    return {
      workspace: workspaceId,
      period: { start: state.period.start.toISOString(), end: state.period.end.toISOString() },
      items: [
        { metric: 'agent_minutes', used: totals.agent_minutes ?? 0, limit: null, pct: null },
        {
          metric: 'tokens',
          used: (totals.tokens_in ?? 0) + (totals.tokens_out ?? 0),
          limit: null,
          pct: null,
        },
        {
          metric: 'queue_items',
          used: queueUsed,
          limit: queueLimit,
          pct: pctOf(queueUsed, queueLimit),
        },
        { metric: 'relay_bytes', used: totals['relay.relay_bytes'] ?? 0, limit: null, pct: null },
        {
          metric: 'seats',
          used: seats.members,
          limit: maxSeats,
          pct: pctOf(seats.members, maxSeats),
        },
      ],
      usage: {
        hosted_minutes_month: hosted?.used ?? 0,
        queue_items_month: queueUsed,
        seats: seats.members,
      },
      limits: {
        hosted_minutes_month: hosted?.limit ?? null,
        queue_items_month: queueLimit,
        max_seats: maxSeats,
      },
      warnings: state.warnings,
    };
  }
}
