# Plans and entitlements (B069)

CT-ENTITLEMENTS and the plan side of CT-API-BILLING: what each workspace may do, as a flat map of
limits with a revision `rev`, and the public plans.

| File            | What it holds                                                                   |
| --------------- | ------------------------------------------------------------------------------- |
| `ports.ts`      | Plan ids, statuses, limit keys, `SubscriptionState`, `UsageReaderPort`, channel |
| `resolve.ts`    | `resolveEntitlements`: a pure function from state, catalog and time to limits   |
| `seed-plans.ts` | The reference limits and the prices; `validateSeedPlans` runs at startup        |
| `repository.ts` | The SQL: `plans`, `plan_limits`, `workspace_entitlements`                       |
| `service.ts`    | `EntitlementService`: `get`, `applySubscriptionState`, `bumpRev`, `plans`       |
| `etag.ts`       | The entitlements ETag and `If-None-Match`                                       |

Routes: `src/routes/plans/` (`GET /v1/plans`, public) and `src/routes/entitlements/`
(`GET /v1/workspaces/{id}/entitlements`, `workspaces:read`, member+).

## Status behaviour (CT-ENTITLEMENTS §4)

| Stored status | Resolves to                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `active`      | the plan's limits                                                              |
| `trialing`    | the plan's limits (the trial plan's); `period.end` is the trial end            |
| `past_due`    | the plan's limits through `grace_until` (`past_due_since` + 7 days), then none |
| `canceled`    | the plan's limits through `period.end` (none without a period), then none      |
| `none`        | plan `free`, status `none`, the free limits, no period                         |

Team's `max_seats` grows by the add-on seats; other plans ignore them. `lan_multiplayer` is always
true. Limits come only from the `plan_limits` rows (cached for 60 s) and the add-on seats.

## `rev`

`rev` is CT-AUTH's `ent` claim. Each row stores the sha256 of the resolved `{plan, status, limits}`
that its `rev` was issued for, so `rev` moves on by exactly 1 when, and only when, that changes:

- `applySubscriptionState(workspaceId, state)` writes billing's state; in the same transaction it
  moves `rev` on if the resolution changed. A renewal (a new period) or a repeated state does not.
- A read that finds the resolution changed without a state change (grace or a canceled period
  ended, or product changed a plan's limits) moves `rev` on under the row's lock.
- `bumpRev(workspaceId, reason)` moves it on without a change (B075's usage warnings).

After each commit that moved `rev`, `{workspace, rev}` is published on `entitlements:invalidate`,
retried once; a failure is counted (`entitlements_invalidate_failures_total`) and logged, and the
change stays committed (consumers' caches expire within 30 s).

A state that cannot be applied (an unknown plan, bad add-on seats, a bad period, `past_due` without
`past_due_since`) throws an `EntitlementError`, writes nothing, and is counted in
`entitlements_state_rejected_total{code}` for alerting.

## Every workspace has a row

The migration backfills a row (free, none, rev 0) for every live workspace; a workspace created
later gets its row from its first read or change. B027's purge needs the worker's
`registerEntitlementsPurgeHook(hooks, createEntitlementRepository(db))` registered before
`startWorkspacePurgeWorker`, since the row's foreign key restricts the delete.

## Wiring

```ts
import { createEntitlementRepository, EntitlementService } from './modules/entitlements/index.js';
import { entitlementRoutes } from './routes/entitlements/index.js';
import { planRoutes } from './routes/plans/index.js';

const entitlements = new EntitlementService({
  repository: createEntitlementRepository(db),
  events: redis.pubsub,
  // usage: B075's reader; until then usage and warnings are empty.
});
await app.register(planRoutes, { service: entitlements });

// B080: reads go through the ≤ 30 s cache; checks for hosted features.
const cached = new CachedEntitlements({
  source: entitlements,
  quota, // B075's QuotaService
  pubsub: redis.pubsub,
  ...loadEntitlementCacheConfig(),
  logger,
  metrics,
});
await cached.start(); // listens on entitlements:invalidate
await app.register(entitlementsPlugin, { enforcer: cached });
await app.register(entitlementRoutes, { service: cached }); // after RBAC and audit
```

Billing lanes call `entitlements.applySubscriptionState(workspaceId, state)` (B072's webhooks,
B078's dunning) and B075 calls `bumpRev(workspaceId, 'usage_warning')`.

## Enforcement (B080)

`enforcement.ts` puts B069's entitlements behind `@centcom/core`'s `EntitlementCache`, which holds
an entry ≤ 30 s and never past a grace or billing period's end, and is invalidated on every
change. It adds `check(workspace, key, current?)`, and `plugins/entitlements.ts` maps checks to
`requireEntitlement` / `requireQuota` preHandlers. Unreadable entitlements fail closed (503). See
`docs/billing/entitlements-enforcement.md`.

## Prices

The prices in `seed-plans.ts` are placeholders (free 0, Pro 1900 per workspace, Team 2900 per
seat, monthly, in USD and EUR minor units) for product to set. They are configuration, not
contract.
