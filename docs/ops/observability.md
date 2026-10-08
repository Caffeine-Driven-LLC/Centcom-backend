# Observability

Lane B093. Every service exports OpenTelemetry metrics and traces to a collector, which forwards
them to Grafana (Mimir for metrics, Tempo for traces, Loki for logs). Metric names come from a fixed
catalogue, labels from small fixed sets, and nothing exported can identify a user, workspace,
session, member or device, or carry content. Alert rules and paging are B094's.

## In a service

```ts
const telemetry = initTelemetry({ service: 'relay', version, env, region, logger });
// Record through telemetry.metrics (core's Metrics interface): e.g. createRedis({ ..., metrics }).
// Trace with telemetry.tracer. On shutdown: await telemetry.shutdown().
```

| Key                           | Default                 | Meaning                                           |
| ----------------------------- | ----------------------- | ------------------------------------------------- |
| `OTEL_ENABLED`                | `true`                  | `false` turns metrics and traces off (local, dev) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | The collector's OTLP/HTTP endpoint                |
| `OTEL_SAMPLE_RATIO`           | `0.05`                  | Share of new traces kept at the source            |

- Telemetry is always off under tests (`NODE_ENV=test` or Vitest), whatever `OTEL_ENABLED` says.
- Metrics are exported every 15 s and spans in batches; each export times out after 5 s, and a
  failed export is dropped and counted (`centcom_otel_export_failed_total{signal}`). At most 2 048
  spans wait for export; beyond that, new spans are dropped. A collector outage never slows a
  request.
- `shutdown()` flushes what is buffered and resolves within 5 s.
- The relay wires all of this in `apps/relay/src/main.ts`. The API and worker have no entrypoint
  yet: their composers should do the same: the API registers `telemetryPlugin` after the request
  context plugin and passes `telemetry.metrics` to it; the worker wraps each processor in
  `traceJob(telemetry, queue, run)` and calls `observeQueues(telemetry.metrics, queues)`; both call
  `observeDbPool` and `sampleRedisLatency`.

## Metrics

The catalogue is `packages/core/src/otel/catalogue.ts`: every metric's type, unit, allowed labels
and who emits it, exported as `centcom_<name>`. Recording anything else does not reach the
collector:

| Record                                                     | What happens               |
| ---------------------------------------------------------- | -------------------------- |
| a name not in the catalogue                                | dropped                    |
| a label the metric does not allow                          | left out                   |
| a value holding an id, an e-mail or IP address, or a query | replaced by `redacted`     |
| a label's 101st distinct value                             | replaced by `__overflow__` |

Each is counted in `centcom_otel_metric_violations_total{kind}` and logged once
(`otel.metric_violation`, names only). Tests run the bridge in strict mode, where each throws
naming the metric and label, so a new label explosion fails CI.

The platform metrics the dashboards and SLOs use:

| Area      | Metrics                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | `http_requests_total{route,method,status_class}`, `http_request_duration_seconds{route,method}`                                                                                    |
| Relay     | `relay_connections`, `relay_connections_total`, `relay_frames_total{t,direction}`, `relay_close_total{code}`, `relay_upgrades_refused_total{reason}`, `relay_handler_errors_total` |
| Jobs      | `job_duration_seconds{queue}`, `job_failed_total{queue}`, `queue_depth{queue}`, `queue_oldest_age_seconds{queue}`                                                                  |
| Pool      | `db_pool_connections{state}`, `db_pool_max_connections`, `db_pool_acquire_seconds`, `db_pool_timeouts_total`, `db_connection_errors_total`, `db_connections_lost_total`            |
| Redis     | `redis_ping_seconds` (a PING every 15 s), and the backend's error counters                                                                                                         |
| Telemetry | `otel_export_failed_total{signal}`, `otel_metric_violations_total{kind}`                                                                                                           |

Catalogued ahead of the lanes that will emit them (dashboards and SLOs already name them):
`relay_handshake_duration_seconds` (B038), `relay_resume_total` and
`relay_resume_duration_seconds` (B042), `relay_fanout_latency_seconds` (B044),
`relay_outbound_buffer_bytes` (B046), `stripe_webhook_lag_seconds` (B072),
`webhook_deliveries_total` and `webhook_first_attempt_seconds` (B081). Their histograms need bucket
bounds at the SLO thresholds: 2 s, 5 s, 0.15 s, 30 s and 10 s.

## Traces

- **API:** one span per request, named by its route template (`GET /v1/users/:id`), with the
  method, route, status code and request id. Incoming `traceparent` is ignored.
- **Jobs:** one span per job execution (`traceJob`).
- **Relay:** one span per connection (`relay.connection`, with its close code). Resume spans come
  with B042. There are no spans per frame, and nothing from a frame.

A sampled span's trace id goes into the log lines of the same request or job (`trace_id`, next to
`request_id`).

Before export, spans lose these attributes: `authorization`, `cookie`, `set-cookie`, `ct`, `p`,
`ticket`, `token`, anything naming a password, secret or API key, and the client's address and user
agent. Ids of users, workspaces, sessions and the like become `usr_[id]`, e-mail addresses
`[email]`, IP addresses `[ip]`. Request ids (`req_`) stay: they link traces and logs. The collector
applies the same rules again.

## The collector

`infra/observability/collector/config.yaml`, for `otel/opentelemetry-collector-contrib` 0.111.0, on
the private network:

1. `memory_limiter`;
2. `attributes/redact` and `resource/redact`: the attributes above, plus `host.ip` and process
   arguments;
3. `transform/scrub` (traces, logs): ids and e-mail addresses in values;
4. `transform/labels` (metrics): `env` and `region` labels from `deployment.environment.name` and
   `cloud.region`;
5. `tail_sampling` (traces): every error, every trace over 1 s, 5 % of the rest;
6. `batch`.

Exporters: OTLP/HTTP to `MIMIR_OTLP_ENDPOINT`, `TEMPO_OTLP_ENDPOINT` and `LOKI_OTLP_ENDPOINT`,
authenticated with `GRAFANA_OTLP_AUTHORIZATION`. The values come from the secret manager (B091); the
file names only the variables. Grafana Cloud's OTLP gateway serves all three: set the three
endpoints to it.

Sampling happens twice. Services keep `OTEL_SAMPLE_RATIO` of new traces (5 %), so the collector
sees errors and slow requests only within that share. Set `OTEL_SAMPLE_RATIO=1` to let the
collector decide alone, at the cost of sending every span to it.

## Dashboards

`infra/observability/dashboards/*.json` (Grafana schema 39). Import them with the Grafana API or
provisioning. Each dashboard has `datasource`, `env` and `region` variables:

| Dashboard          | Shows                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| API overview       | Availability and latency SLO burn, requests by status and route, 5xx share, p95 by route, rate limits  |
| Relay overview     | Connections, frames, closes, refused upgrades, handshake, fan-out, resume, outbound buffer             |
| Workers and queues | Queue depth and age, job p95 and failures, e-mail, push, outgoing webhooks                             |
| Billing and Stripe | Stripe webhook lag and burn, entitlement revisions and refusals, seats, quotas, usage events           |
| Database and Redis | Pool saturation and states, acquire p95, timeouts, Redis PING p95 and errors, failed telemetry exports |

Every query uses catalogued metrics (a test checks each one).

## SLOs

`infra/observability/slo/*.slo.yaml`, each `{name, objective, window, owner, sli: {good, total}}`.
The numbers are proposals for the owner to ratify:

| SLO                | Objective | Good events, of all                                       |
| ------------------ | --------- | --------------------------------------------------------- |
| `api-availability` | 99.9 %    | API answers that are not 5xx (health checks excluded)     |
| `api-latency`      | 95 %      | API answers within 300 ms (health checks excluded)        |
| `relay-connect`    | 99.5 %    | relay handshakes that succeed within 2 s                  |
| `relay-fanout`     | 99 %      | frames delivered in-region within 150 ms                  |
| `resume-success`   | 99 %      | resumes that succeed within 5 s                           |
| `stripe-webhook`   | 99 %      | Stripe events processed within 30 s                       |
| `webhook-delivery` | 95 %      | outgoing webhooks whose first attempt is answered in 10 s |

All are measured over 30 days. `rules.yaml` holds the recording rules, generated by
`pnpm --filter @centcom/core gen:slo-rules`: for each SLO, `slo:sli_error:ratio_rate<w>` and
`slo:burn_rate:<w>` over 5m, 1h, 6h and 3d, by `env`. A burn rate of 1 spends the error budget over
exactly the window. `rules.test.yaml` checks them with `promtool test rules`: a 1.44 % error rate
against 99.9 % is a burn rate of 14.4.

## Checks

| Test                                              | What it checks                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/otel/otel.catalogue.test.ts`  | catalogue completeness, label allow-list, the bridge, a 2 000-session cardinality run                                   |
| `packages/core/test/otel/otel.telemetry.test.ts`  | config, span redaction, job traces and log correlation, hooks, collector down                                           |
| `packages/core/test/otel/otel.infra.test.ts`      | collector config, dashboards against the catalogue, SLO files and rules                                                 |
| `packages/core/test/otel/otel.containers.test.ts` | (with Docker) the collector redacting a sample span and receiving metrics, Grafana importing the dashboards, `promtool` |
| `apps/api/test/telemetry/otel.http.test.ts`       | request spans, `trace_id` in logs, API metrics present and catalogued                                                   |
| `apps/api/test/telemetry/otel.perf.test.ts`       | at most 5 % on the API p95, shutdown within 5 s                                                                         |
| `apps/relay/test/relay.telemetry.test.ts`         | relay metrics present, one span per connection                                                                          |
