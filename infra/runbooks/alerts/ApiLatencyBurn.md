# ApiLatencyBurn

Severity: `page` (14.4x over 1 h and 5 m, or 6x over 6 h and 30 m), `ticket` (3x over 3 d) ·
Service: `api` · Owner: `platform` · SLO: `api-latency` (95 % of API answers within 300 ms) ·
Rules: [api.rules.yaml](../../alerts/rules/api.rules.yaml)

## Symptoms

Too many API answers take over 300 ms: 72 % or more over an hour (fast), 30 % or more over 6 hours
(slow), or 15 % or more over 3 days (ticket). Customers report a slow app, spinners and timeouts.

## Impact

Every API action feels slow; clients may time out and retry, which adds load. Sessions already on
the relay are not affected.

## Dashboards

- `$GRAFANA/d/centcom-api-overview?var-env=$ENV`: "Latency p95 by route", "Latency burn rate, 1 h",
  "Requests by route".
- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Pool acquire p95", "Redis PING p95".

## Triage commands

1. Which routes are slow (Grafana Explore):
   `topk(5, histogram_quantile(0.95, sum by (route, le) (rate(centcom_http_request_duration_seconds_bucket{env="$ENV"}[5m]))))`.
2. Is the database the wait:
   `histogram_quantile(0.95, sum by (le) (rate(centcom_db_pool_acquire_seconds_bucket{env="$ENV"}[5m])))`
   above 0.05 s means requests queue for a connection ([DbPoolSaturation](DbPoolSaturation.md)).
3. Is Redis slow: `histogram_quantile(0.95, sum by (le) (rate(centcom_redis_ping_seconds_bucket{env="$ENV"}[5m])))`.
4. Is it load: `sum(rate(centcom_http_requests_total{env="$ENV"}[5m]))` against last week's, and
   machine CPU in `fly status -a centcom-$ENV-api`.

## Mitigation

- Load: `fly scale count <n + 2> -a centcom-$ENV-api`.
- A slow query after a release: roll back (see [ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md#mitigation)).
- Pool exhausted: see [DbPoolSaturation](DbPoolSaturation.md).
- An abusive client: the rate limits (B023) should hold it; check "Rate limit refusals" on the API
  overview. If one account is the source, disable it through the admin API
  (`POST /internal/admin/v1/users/<user id>/disable`, see `docs/admin/admin-api.md`) and record why.

## Escalation

Page the secondary on-call after 30 minutes without a lead. The platform team owns query and
index fixes. Open a status incident when customers report it.

## Verification

`slo:burn_rate:5m{slo="api-latency", env="$ENV"}` is under 1 and the p95 query from step 1 is under
0.3 s for the top routes; the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=ApiLatencyBurn env=$ENV`).

## Post-incident

Note the slow routes and the cause in the postmortem or ticket; a recurring slow route needs an
index, a cache or a smaller page size, filed with the platform team.
