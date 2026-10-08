# Entitlement enforcement

Owner: lane B080. How the API and the relay decide what a workspace's plan allows
([CT-ENTITLEMENTS](../../contracts/07-billing-entitlements.md)), quickly and safely.

## Where the answer comes from

| Layer                                                                   | What it holds                                             | Lane |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ---- |
| SQL (`workspace_entitlements`, `plan_limits`)                           | The source of truth: plan, status, period, limits, `rev`. | B069 |
| `EntitlementCache` (`@centcom/core`, also `@centcom/core/entitlements`) | A per-process copy, at most 30 s old.                     | B080 |
| `CachedEntitlements` (API)                                              | The cache over B069, plus `check`.                        | B080 |
| `QuotaService`                                                          | Authoritative usage counters for metered limits.          | B075 |

### Freshness

- An entry is served for at most `ENT_CACHE_TTL_MS` (default and maximum 30 000 ms). It is also
  never served past the end of its grace period (`grace_until`) or billing period (`period.end`),
  so a `past_due` workspace reads `none` 1 ms after its grace ends, without waiting for any job.
- **Every change is announced.** B069 publishes `{workspace, rev}` on the Redis channel
  `entitlements:invalidate` after each change, and every process's cache drops that workspace.
  `CachedEntitlements.invalidate(workspace)` does the same from any process.
- **A lost message costs at most the TTL.** No entry is ever older than 30 s.
- **The cache is bounded** to 10 000 workspaces (least recently used out). Concurrent misses share
  one load, and a load that overlapped an invalidation is not kept.

## Checks

`check(workspace, key, current?)` and the Fastify preHandlers (`apps/api/src/plugins/entitlements.ts`):

| Key kind                                                                      | Allowed when                                           | Refusal                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `lan_multiplayer`                                                             | always (never looked up)                               | never                                                                                                                           |
| Flag (`relay_access`)                                                         | `true`                                                 | 403 `entitlement_required`                                                                                                      |
| Count (`max_seats`, `webhooks_max`, `api_keys_max`, `max_session_members`, …) | limit `null`, or `current` < limit (0 always refuses)  | 403 `seat_limit_reached`, `webhook_limit_reached`, `api_key_limit_reached`, `member_limit_reached`, else `entitlement_required` |
| Metered (`hosted_minutes_month`, `queue_items_month`)                         | B075's counters below the limit (`null` never refuses) | 429 `quota_exceeded`, `retry_after_s` and `Retry-After` = seconds to `period.end`                                               |

Unknown limit keys are kept on read (additive keys) and never enforced.

```ts
app.post(
  '/v1/workspaces/:id/sessions',
  {
    preHandler: [
      requireScope('sessions:write'),
      requireEntitlement('relay_access'),
      requireQuota('hosted_minutes_month'),
    ],
  },
  handler,
);
app.post(
  '/v1/workspaces/:id/webhooks',
  { preHandler: requireEntitlement('webhooks_max', { current: (r) => countWebhooks(r) }) },
  handler,
);
```

Put entitlement checks after the route's own access check, so a caller who may not see a
workspace never learns its plan.

## Failing closed

- **If neither SQL nor a fresh cache entry is available,** `get` and every hosted check answer 503
  `service_unavailable` with `retry_after_s`; they never allow. A failure is never cached.
- **`ENT_STALE_ON_ERROR_MS`** (default 0) lets a just-expired entry stand in for that long when SQL
  fails. Each such read counts in `ent_cache_stale_served_total`, which stays 0 unless it is set.
- **LAN and local use never reach the backend** and are never checked.

## What must not be trusted

Plans, roles and the access token's `ent` claim sent by a client are hints at most. Every
decision reads server state: roles through B021's RBAC, limits through this cache or SQL, and
usage through B075's counters. `usage` in the entitlements object is best effort (≤ 60 s) and is
never used to enforce.

## Configuration

| Key                     | Default | Notes                                         |
| ----------------------- | ------- | --------------------------------------------- |
| `ENT_CACHE_TTL_MS`      | `30000` | 1 to 30 000; a larger value refuses to start. |
| `ENT_STALE_ON_ERROR_MS` | `0`     | 0 to 60 000.                                  |

## Metrics

- `ent_cache_loads_total`
- `ent_cache_load_failures_total`
- `ent_cache_stale_served_total`
- B075's `quota_crossings_total`
