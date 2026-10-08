# Usage ingestion (B074)

`POST /v1/usage/events` ([CT-API-USAGE](../../../../../contracts/02-rest-api.md)): devices report
usage events in batches, and the API stores them, deduplicated, for B075 to aggregate.

## Pieces

| File             | What it does                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `validate.ts`    | `parseUsageBatch`: the batch and event rules; one bad event fails the batch. |
| `attribution.ts` | Which workspace each event counts against.                                   |
| `ingest.ts`      | `UsageIngest`: attribution, the daily cap, the insert, B075's hint, 503s.    |
| `repository.ts`  | `usage_event`, and the session and membership lookups.                       |

Route: `routes/usage/index.ts`.

## The request

- Scope `usage:write`, from a user's device token. An API key or a token without a device is 403.
- `Idempotency-Key` is required (B024):
  - without it, 400 `idempotency_key_required`;
  - a replay answers the stored response with `Idempotency-Replayed: true`;
  - the same key with another body is 409;
  - with the idempotency store down, 503.
- At most 1 MiB (413) and 1 to 500 events.
- 60 requests a minute per device (B023's `usage` bucket); the 61st is 429.
- The answer is `200 {accepted, duplicates}`.

## Events

| Field                    | Rule                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `id`                     | `use_` ULID, once per batch                                                          |
| `type`                   | `agent_minutes`, `tokens_in`, `tokens_out`, `queue_items`, `relay_bytes`             |
| `qty`                    | whole number, 0 to the type's cap: 1 440; 2 000 000 000; 2 000 000 000; 10 000; 2^40 |
| `at`                     | RFC 3339, within the last 31 days and at most 60 s ahead of the server clock         |
| `session_id`, `agent_id` | `ses_` / `agt_` ids, optional                                                        |

Any problem fails the whole batch with 422, every problem listed with its pointer
(`/events/3/qty`), and nothing is stored. Unknown fields are ignored and never stored.

## Attribution

1. **With `session_id`:** the session's workspace, whatever the token's `wsp` claim says. The caller
   must take part in the session (a member on any device, or its creator). A session that does
   not exist, or is someone else's, is 403 for the whole batch.
2. **Else the token's `wsp` claim,** while the caller is still a member of that live workspace.
3. **Else the caller's personal workspace:** the first live workspace they created and own (B022).

## Storage and dedupe

`usage_event` (migration `20260102002100`) has primary key `(workspace_id, event_id)`. The batch is
one `insert … on conflict do nothing`, so an event already stored for its workspace, by an earlier
request or a concurrent one, counts as a duplicate. Dedupe is per workspace, so a client cannot
probe another workspace's ids.

Rows hold the contract fields, the device and `received_at`, nothing else.

## Limits that do not depend on the plan

- **The daily cap** (`USAGE_DAILY_EVENT_CAP`, default 1 000 000 events a workspace a UTC day) is an
  abuse limit: past it the batch is 429 `rate_limited` until midnight UTC.
  - Its counter is a Redis value, read then written, so concurrent batches can overshoot it a
    little.
  - When Redis fails, it does not block.
- **Plan quotas are not checked here.** Usage is a fact and is always recorded; quotas are
  enforced elsewhere.

## B075

After a batch stores anything, `{workspaces, received_at}` is published on `usage:ingested`. A
failed hint is logged and never fails the batch; B075 also sweeps new rows by `received_at`
(indexed).

## Failures

A database timeout or lost connection is a 503 with `retry_after_s`. The client retries with the
same Idempotency-Key and event ids.

## Wiring

```ts
const ingest = new UsageIngest({
  repository: createUsageRepository(db),
  kv: redis.kv,
  dailyEventCap: loadUsageConfig().dailyEventCap,
  pubsub: redis.pubsub,
  logger,
  metrics,
});
await app.register(usageRoutes, { ingest });
// After the request-context, error-handler, rate-limit, auth and idempotency plugins.
```

## Tests

`apps/api/test/usage/ingest/`:

- `usage.validate`: field rules, caps, the time window and batch limits.
- `usage.ingest`: dedupe, concurrency, the daily cap, the hint and 503s; on Postgres, 500 events
  within 500 ms.
- `usage.attribution`: the three rules, with a Postgres variant.
- `usage.authz`: scope, principal types and the participant check.
- `usage.idempotency-rate`: Idempotency-Key and the per-device limit.
- `usage.contract`: schemas and the CT-ERR error shape.
