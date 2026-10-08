# RedisMemoryHigh

Severity: `ticket` · Service: `redis` · Owner: `platform` · Metrics: `redis_memory_used_bytes`,
`redis_memory_max_bytes` (redis_exporter, see [exporters.yaml](../../alerts/exporters.yaml)) ·
Rules: [redis.rules.yaml](../../alerts/rules/redis.rules.yaml)

## Symptoms

Redis has used over 80 % of its `maxmemory` for 10 minutes.

## Impact

At the limit Redis evicts keys or refuses writes, depending on its policy: BullMQ queues, rate
limits, presence, relay resume state and caches all live there. Nothing breaks yet at 80 %.

## Dashboards

- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Redis PING p95", "Redis errors".
- `$GRAFANA/d/centcom-workers-queues?var-env=$ENV`: "Queue depth" (a backlog is the usual cause).

## Triage commands

1. How fast is it growing (Grafana Explore):
   `max(redis_memory_used_bytes{env="$ENV"} / redis_memory_max_bytes{env="$ENV"})` over 24 hours.
2. Is a queue backing up: `topk(5, centcom_queue_depth{env="$ENV"})`.
3. What uses the memory: `redis-cli -u "$REDIS_URL" info memory` and
   `redis-cli -u "$REDIS_URL" --bigkeys` (it scans; run it once, on a replica if there is one).
4. Is eviction already happening: `redis-cli -u "$REDIS_URL" info stats | grep evicted_keys`, and
   `sum(rate(centcom_redis_memory_evictions_total{env="$ENV"}[5m]))`.

## Mitigation

- A queue backlog: fix its consumer (see [StripeWebhookLag](StripeWebhookLag.md) or
  [DeadLetterNonEmpty](DeadLetterNonEmpty.md)); the memory comes back as it drains.
- Completed or failed BullMQ jobs piling up: check the queue's `removeOnComplete` and
  `removeOnFail` settings (most keep 7 days of failures).
- Organic growth: raise `maxmemory` or the instance size at the provider.

## Escalation

A ticket for the platform team. Raise it to the primary on-call if it passes 95 % or evictions
start.

## Verification

The ratio in step 1 is back under 0.7 and `evicted_keys` stops increasing.

## Post-incident

Record what grew. A queue that keeps too many finished jobs needs a retention change in its job
module.
