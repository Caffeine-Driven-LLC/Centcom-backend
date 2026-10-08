# Health and status (B086)

The API's `/healthz`, `/readyz` and public `/v1/status` feed
([CT-STATUS](../../../../../contracts/00-foundations.md)). The operator's guide is
[docs/platform/status.md](../../../../../docs/platform/status.md).

## Pieces

| File            | What it does                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------- |
| `readiness.ts`  | `Readiness`: `SELECT 1`, Redis `PING`, migrations at the expected version, 1 s each.          |
| `aggregate.ts`  | Worst-of, and the probe hysteresis (1 failure degraded, 3 major outage, 2 successes back).    |
| `prober.ts`     | `ComponentProber`: URL or heartbeat probes, one round per component per 15 s cluster-wide.    |
| `service.ts`    | `StatusFeed` (the cached feed, 32 KiB budget, last-good fallback) and `StatusAdmin`.          |
| `repository.ts` | `status_incidents`, `status_incident_updates`, `status_deprecations`.                         |
| `config.ts`     | `STATUS_COMPONENTS`, `MIN_CLIENT_VERSION`, `READYZ_TIMEOUT_MS`, `EXPECTED_MIGRATION_VERSION`. |

Routes: `routes/status.ts`. Migration: `20260102002800_status.sql`.

## Wiring

```ts
const config = loadStatusConfig();
const readiness = new Readiness({
  db,
  redis,
  expectedVersion: config.expectedMigrationVersion,
  timeoutMs: config.readyzTimeoutMs,
});
const feed = new StatusFeed({
  prober: new ComponentProber({ components: config.components, kv: redis.kv, metrics }),
  repository: createStatusRepository(db),
  kv: redis.kv,
  components: config.components,
  minClientVersion: config.minClientVersion,
  logger,
  metrics,
});
await app.register(statusRoutes, { feed, readiness });
// B087's tooling: new StatusAdmin({ repository, components: config.components })
```

## Rules

- `/healthz` touches nothing. `/readyz` reports `{ok}` per check, never an error, host or version.
- `/v1/status` is always 200 (informational: clients must not gate local or LAN use on it), built
  at most every 15 s per instance, served from the last good build for 5 minutes when Postgres or
  Redis fails, then as a degraded feed with a `status-data` component.
- Incident text is at most 500 characters and may not hold e-mail or IP addresses or credentials.

## Tests

`apps/api/test/status/`: `status.units.test.ts` (worst-of, hysteresis, ordering and expiry, the
32 KiB budget, admin checks, configuration), `status.routes.test.ts` (health, readiness per
dependency, contract and headers, probes, two-instance de-duplication, hanging targets, outages),
`status.perf.test.ts` (`/healthz` p99 in a child process via `status-bench.ts`), and on Postgres
`status.postgres.test.ts` (readiness with a pending migration or no migrations table; the tables).
