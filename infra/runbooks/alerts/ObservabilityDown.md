# ObservabilityDown

Severity: `page`, also sent at once to the separate fallback channel · Service: `platform` · Owner:
`platform` · Rules: [platform.rules.yaml](../../alerts/rules/platform.rules.yaml)

## Symptoms

A service (`job`, for example `centcom/centcom-relay`) that exported metrics an hour ago (its pool
gauge, `centcom_db_pool_max_connections`, between 15 and 75 minutes back) has exported nothing for
10 minutes. Dashboards for it go blank. This is the "metrics pipeline down" meta-alert (B094's
failure modes).

## Impact

Every alert that reads this service's metrics is blind: an outage would reach on-call only through
support. The service itself may be fine. It pages because the protection is gone, and it goes to
the fallback channel too because the normal paging path may share the failure.

## Dashboards

- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Telemetry exports failed" (the services count
  failed exports when the collector is unreachable).

## Triage commands

1. Which services are missing (Grafana Explore): `group by (job) (centcom_db_pool_max_connections{env="$ENV"})`
   against the same query an hour ago (`offset 1h`).
2. Is the service running: `fly status -a centcom-$ENV-<service>`, and `curl -sS "$API/healthz"`.
3. Are exports failing at the source:
   `fly logs -a centcom-$ENV-<service> --no-tail | grep -i 'otel\|export' | tail -n 20`, and
   `sum by (signal) (rate(centcom_otel_export_failed_total{env="$ENV"}[5m]))` for services that
   still report.
4. Is the collector up: `fly status -a centcom-$ENV-otel-collector` (or wherever B091 runs it)
   and its health endpoint, `curl -sS http://<collector host>:13133/`.
5. Is Grafana Cloud ingesting: `curl -sS https://status.grafana.com/api/v2/status.json` (its
   status page), and whether other services' metrics still arrive (step 1).

## Mitigation

- The collector is down: restart it, `fly machine restart <machine id> -a <collector app>`.
- Credentials expired (`GRAFANA_OTLP_AUTHORIZATION`): rotate the token in the secret manager and
  restart the collector.
- The service's telemetry is off (`OTEL_ENABLED=false` set by mistake): set it back and redeploy.
- While blind: watch customer-facing health by hand: `curl -sS "$API/v1/status"` and
  `curl -sS "$API/readyz"` every few minutes, and tell support.

## Escalation

Page the secondary on-call after 30 minutes. Grafana Cloud support if ingestion is down on their
side.

## Verification

The query in step 1 lists the service again, its dashboards fill in, and the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=ObservabilityDown env=$ENV`).

## Post-incident

Note the blind window in the postmortem: anything that happened in it was not alerted on, so look
at the error logs for that period.
