# Telemetry (B085)

Opt-in telemetry ([CT-TELEMETRY](../../../../../contracts/08-integrations.md),
`contracts/schemas/telemetry.schema.json`): batches are scrubbed against a closed allow-list and
stored without anything that identifies a person, for 90 days, then kept as daily counts. The
operator's guide is [docs/platform/telemetry.md](../../../../../docs/platform/telemetry.md).

## Pieces

| File            | What it does                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `scrub.ts`      | `scrubBatch`: the allow-list of types and props, PII patterns, enums, drop reasons.               |
| `service.ts`    | `TelemetryIngest`: address limit, content checks, install limit, scrub, one INSERT. Never throws. |
| `limits.ts`     | 120 batches a minute per address (hashed hourly with a salt), 12 per `install_id`.                |
| `repository.ts` | Day partitions (`telemetry_events_YYYYMMDD`), rollups, partition drops.                           |
| `retention.ts`  | `TelemetryRetention`: roll up each day once, drop days older than 90.                             |
| `config.ts`     | `TELEMETRY_RETENTION_DAYS` (must be 90), batch limits, `TELEMETRY_IP_SALT`.                       |

Route: `routes/telemetry.ts`. Worker: `apps/worker/src/jobs/telemetry-retention/`. Migration:
`20260102002700_telemetry.sql`.

## Wiring

```ts
const config = loadTelemetryConfig();
const repository = createTelemetryRepository(db);
const ingest = new TelemetryIngest({
  repository,
  limits: new TelemetryLimits(redis.rateLimit, config.ipSalt),
  config,
  logger,
  metrics,
});
// B023's limiter answers 429: the telemetry route must be exempt from it (it has its own limits).
await app.register(rateLimitPlugin, { ..., config: { ...rateLimit, exempt: [...exempt, TELEMETRY_ROUTE] } });
await app.register(telemetryRoutes, { ingest, clientIp: (r) => resolveClientIp(r, trustedHops) });

// Worker:
const retention = new TelemetryRetention({ repository, retentionDays: config.retentionDays });
startTelemetryRetentionWorker({ connection, rollup: (d) => retention.rollup(d), drop: (b) => retention.drop(b) });
await scheduleTelemetryRetention(createTelemetryRetentionQueue({ connection }));
```

## Rules

- **Always 204**, with an empty body and no `Retry-After`, whatever happens (CT-TELEMETRY rule 4).
  The route parses bodies itself and has its own error handler, so the framework's 400/413/415
  never answer.
- **No linkage:** the route reads no credential (`auth: false`); nothing about the caller is stored
  or logged. The address only feeds a rate-limit key (an HMAC of the hour and the address).
- **Closed allow-list:** unknown types, props and fields are dropped; new ones need a Contract PR.
- **Day partitions** are created on demand (`telemetry_ensure_partition`) and dropped after 90
  days (`telemetry_drop_partitions`), both owner functions, so the services need no DDL rights.

## Tests

`apps/api/test/telemetry/`: `telemetry.units.test.ts` (each rule, ULIDs, enums, the address key,
configuration), `telemetry.routes.test.ts` (always 204, privacy, linkage, limits, failures,
fixtures, fuzz), `telemetry.retention.test.ts`, and on Postgres `telemetry.postgres.test.ts`
(partitions, columns, rollup and drop, p95). The worker's: `apps/worker/test/telemetry-retention.test.ts`.
