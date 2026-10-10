# Quota signals (B076)

Turns metered usage (B075) into one-time signals at 80 % and 100 % per workspace, limit and
period: a `sys.notice` to live hosted sessions, a notification to owners and a `usage.threshold`
webhook event. It also keeps the `quota:state:{wsp}` flag that B080 and the relay read. The full
description (rules, failure handling, configuration, metrics) is
[`docs/billing/quota-signals.md`](../../../../../../docs/billing/quota-signals.md).

## Pieces

| File             | What it does                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `levels.ts`      | `levelOf`, `pctOf` (BigInt arithmetic), the levels to claim or re-arm, `QuotaTransition`.                          |
| `service.ts`     | `QuotaSignals`: `evaluateQuota`, `deliver`, `getQuotaState`, `getWarnings`.                                        |
| `store.ts`       | `createQuotaSignalStore`: `quota_signal_state` on Postgres, the workspace lock, sweep sources.                     |
| `delivery.ts`    | The notice, notification and webhook payloads; `relay:notice:{wsp}`; `pubsubNotices`.                              |
| `state-cache.ts` | The `QuotaStateCache` port, `quota:state:{wsp}`, its in-memory twin.                                               |
| `triggers.ts`    | `withQuotaSignals` (B075's aggregator), `subscribeEntitlementChanges`, `sweepQuota`, `quotaWarningsReader` (B069). |
| `config.ts`      | `loadQuotaSignalConfig`: QUOTA_WARN_PCT, QUOTA_EVAL_DEBOUNCE_MS, QUOTA_SWEEP_INTERVAL_S.                           |
| `index.ts`       | The module's exports.                                                                                              |

The worker's `jobs/quota-signals/` holds the `quota-signals` queue (`evaluate`, `sweep`), its
dead-letter queue `quota-signals.dead`, and the Redis implementation of the hash
(`createRedisQuotaStateCache`). Table: `quota_signal_state` (migration
`20260102004500_quota_signal_state.sql`, types in `@centcom/db`'s `schema/quota-signals.ts`).

## Wiring

```ts
const config = loadQuotaSignalConfig();
const store = createQuotaSignalStore(db);
const stateRedis = createQuotaStateRedisClient({ url, keyPrefix: keyPrefixFor(env), logger }); // @centcom/worker
const signals = new QuotaSignals({
  store,
  counters: createCounterStore(db), // B075
  entitlements, // B069's EntitlementService
  cache: createRedisQuotaStateCache(stateRedis), // @centcom/worker
  notices: pubsubNotices(redis.pubsub), // B009
  notify: dispatcher, // B063's NotificationDispatcher
  emitWebhook, // B081's createWebhookEventEmitter(...)
  logger,
  metrics,
});

// Worker process:
const queue = createQuotaSignalsQueue({ connection, prefix });
const enqueue = (ws: string) => enqueueQuotaEvaluate(queue, ws, config.debounceMs);
const aggregator = new UsageAggregator({ ..., quota: withQuotaSignals(quota, enqueue, logger) });
await subscribeEntitlementChanges(redis.pubsub, enqueue, logger);
await scheduleQuotaSweep(queue, config.sweepIntervalS);
startQuotaSignalsWorker({
  connection,
  prefix,
  deadLetter: createQuotaSignalsDeadQueue({ connection, prefix }),
  evaluate: (ws) => signals.evaluateQuota(ws),
  sweep: () => sweepQuota({ store, enqueue: (ws) => enqueueQuotaEvaluate(queue, ws, 0), now: new Date() }),
  logger,
  metrics,
});

// B080 and the relay: signals.getQuotaState(ws). B069's warnings[]:
// usage: withSeatUsage(seats, quotaWarningsReader(createUsageReader(counters), store)).
```
