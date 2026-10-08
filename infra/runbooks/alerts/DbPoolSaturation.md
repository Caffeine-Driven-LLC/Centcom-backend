# DbPoolSaturation

Severity: `ticket` · Service: `postgres` · Owner: `platform` · Rules:
[postgres.rules.yaml](../../alerts/rules/postgres.rules.yaml)

## Symptoms

A service's database pool (B007; `job` names the service) has had over 90 % of its connections in
use for 5 minutes.

## Impact

Requests and jobs wait for a connection, so latency rises; past the acquire timeout they fail with
a pool timeout. Customers notice only when the API slows or errors, and then
[ApiLatencyBurn](ApiLatencyBurn.md) or [ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md) pages.

## Dashboards

- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Pool saturation", "Pool connections by
  state", "Pool acquire p95", "Pool timeouts and lost connections".

## Triage commands

1. Which service and how full (Grafana Explore):
   `max by (job) (centcom_db_pool_connections{env="$ENV", state="in_use"} / ignoring (state) centcom_db_pool_max_connections{env="$ENV"})`.
2. Are requests waiting: `max by (job) (centcom_db_pool_connections{env="$ENV", state="waiting"})`
   and `sum(rate(centcom_db_pool_timeouts_total{env="$ENV"}[5m]))`.
3. What holds the connections:
   `psql "$DATABASE_URL" -c "select state, wait_event_type, count(*), max(now() - query_start) from pg_stat_activity where datname = current_database() group by 1, 2 order by 3 desc"`.
4. Is it load or slowness: `sum(rate(centcom_http_requests_total{env="$ENV"}[5m]))` against last
   week, and the slow routes on `$GRAFANA/d/centcom-api-overview?var-env=$ENV` ("Latency p95 by
   route").

## Mitigation

- Long-running or idle-in-transaction sessions: end the worst one,
  `psql "$DATABASE_URL" -c "select pg_terminate_backend(<pid>)"`.
- Load: add machines (each brings its own pool), `fly scale count <n + 1> -a centcom-$ENV-<service>`,
  while staying under Postgres' `max_connections`.
- A slow query after a release: roll back the service (see
  [ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md#mitigation)).

## Escalation

A ticket for the platform team. If the API starts timing out, the SLO alerts page and the incident
runs from there.

## Verification

The query in step 1 stays under 0.7 and `centcom_db_pool_timeouts_total` stops increasing.

## Post-incident

Record which service and why. Raise the pool size only together with Postgres' connection limit;
fix slow queries first.
