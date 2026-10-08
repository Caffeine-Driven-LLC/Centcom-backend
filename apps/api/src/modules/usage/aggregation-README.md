# Usage aggregation and quotas (B075)

Folds raw usage (B074's `usage_event` and the relay's counters) into per-period counters, computes
quota state against the entitlements' limits, records 80 % and 100 % crossings once per period,
feeds `usage` and `warnings` into the entitlements object (B069), and serves the usage summary.

## Pieces

| File           | What it does                                                                           |
| -------------- | -------------------------------------------------------------------------------------- |
| `period.ts`    | Periods: the subscription's (stepping back for late events) or the UTC calendar month. |
| `counters.ts`  | `usage_counter`, `quota_state`, `usage_aggregate_cursor` (SQL).                        |
| `aggregate.ts` | `UsageAggregator.run`: events, the relay, crossings.                                   |
| `quota.ts`     | `QuotaService`: `compute`, `check` (for B080), `detectCrossings`.                      |
| `reader.ts`    | B069's `UsageReaderPort`, and `UsageSummaryService`.                                   |

Also `routes/usage-summary/index.ts` and the worker's `jobs/usage-aggregate.ts` (every 15 s).

## Metrics and meters

| Counter                                                                  | From                        | Compared with a limit                     |
| ------------------------------------------------------------------------ | --------------------------- | ----------------------------------------- |
| `agent_minutes`, `tokens_in`, `tokens_out`, `queue_items`, `relay_bytes` | devices (B074)              | never: informational (CT-ENTITLEMENTS §5) |
| `relay.hosted_minutes`                                                   | the relay lifecycle service | `hosted_minutes_month`                    |
| `relay.queue_items`                                                      | the relay                   | `queue_items_month`                       |
| `relay.relay_bytes`                                                      | the relay                   | never                                     |

LAN and local use never reach the backend, so it is never counted or blocked.

## The aggregator

`UsageAggregator.run(now)` runs every 15 s, one run at a time.

1. **Events.** In one transaction holding the cursor, it sums the rows received after the
   high-water mark and at least 30 s ago (`SETTLE_MS`, so rows still being written wait). The sums
   are by workspace, type and second of `at`.
   - Each sum goes to the period it happened in, so a late event counts in its earlier period.
   - The counters and the new mark commit together. A crash changes nothing, and a rerun never
     double counts.
2. **The relay.** For each workspace with waiting counts, it takes them into the current period.
   If the relay is down, client metrics still aggregate; `usage_relay_unavailable_total` counts
   the failure and the relay's counts are taken next run.
3. **Crossings.** Every touched workspace is checked. One whose check failed is checked again
   next run.

Usage reaches quotas within 45 s (30 s settle and a 15 s schedule).

## Quotas

- **Limits** come from the entitlements (B069), with status resolution already applied.
  - `null` is unlimited: pct `null`, never exceeded.
  - `0` allows nothing: 0 used is pct 0, any use is pct 100 and exceeded.
  - Otherwise pct = `floor(used × 100 / limit)` and exceeded = `used ≥ limit`.
- **Warnings:** each limit at ≥ 80 % appears with pct 80 or 100.
- **Crossings:** at most one per (workspace, limit, period, threshold).
  - The crossing is claimed in `quota_state`, and B069's `bumpRev('usage_warning')` runs inside the
    same transaction; if the bump fails, nothing is marked and the next run retries.
  - It then goes out as `QuotaCrossed {workspace, limit, pct, resets_at}` (`pubsubQuotaEvents`:
    channel `quota:crossed`) for B076.
- **`check(workspace, key)`** answers `{allowed, retryAfterS}` for B080, where `retryAfterS` is the
  time to the period's end.
- **Period:** the entitlements' period when subscribed, else the UTC calendar month. At `end` the
  next period starts at 0; old periods' counters and crossings are kept.

## The entitlements object

`createUsageReader(counters)` gives B069 `usage.hosted_minutes_month`, `usage.queue_items_month`
and `warnings`, from stored crossings: pct 100 once crossed, else 80. It reads stored state only,
never limits, so B069 can call it while building the object. Wrap it in B030's `withSeatUsage`
for `usage.seats` (seats in use, never Stripe's quantity).

## `GET /v1/workspaces/{id}/usage/summary`

- Scope `billing:read`, role member+ (B021 `workspace.read`). A guest gets 403, a non-member 404.
- The body is CT-API-USAGE's `UsageSummary`, `{workspace, period, items}`.
  - Items are `agent_minutes`, `tokens` (in + out), `queue_items`, `relay_bytes` and `seats`
    (seats in use against `max_seats`).
  - Additively, the card's `usage`, `limits` and `warnings` carry `hosted_minutes_month`, which the
    contract's item list has no metric for.

## Wiring

```ts
const counters = createCounterStore(db);
const entitlements = new EntitlementService({
  ...,
  usage: withSeatUsage(seats, createUsageReader(counters)),
});
const quota = new QuotaService({
  counters,
  entitlements,
  rev: entitlements,
  events: pubsubQuotaEvents(redis.pubsub),
  logger,
  metrics,
});
const aggregator = new UsageAggregator({
  counters,
  periods: { period: async (ws) => toPeriod((await entitlements.get(ws))?.period) },
  relay, // the relay lifecycle service's RelayCounterPort
  quota,
  logger,
  metrics,
});
await app.register(usageSummaryRoutes, {
  summary: new UsageSummaryService({ counters, quota, seats, entitlements }),
});
// Worker: startUsageAggregateWorker({ connection, run: (now) => aggregator.run(now) }).
```

## Tests

`apps/api/test/usage/aggregation/`:

- `usage.aggregate`: idempotency, the high-water mark, late events and the relay, with a Postgres
  variant.
- `usage.quota`: thresholds, null and zero limits, and a property test.
- `usage.period`: periods and rollover.
- `usage.crossing`: once-per-period emission and the rev bump.
- `usage.summary-route`: authorisation and shape.
- `usage.entitlements-integration`: usage and warnings in the entitlements object.

`apps/worker/test/usage-aggregate.test.ts` covers the worker job.
