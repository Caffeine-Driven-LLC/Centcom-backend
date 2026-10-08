# ApiAvailabilityFastBurn

Severity: `page` · Service: `api` · Owner: `platform` · SLO: `api-availability` (99.9 % of API
answers are not 5xx, health checks excluded) · Rules: [api.rules.yaml](../../alerts/rules/api.rules.yaml)

## Symptoms

At least 1.44 % of API requests answered 5xx over the last hour and over the last 5 minutes (a
burn rate of 14.4 against the 0.1 % error budget), for 2 minutes. Support hears "something went
wrong" from the app, failed sign-ins or workspaces that do not load.

## Impact

Customers cannot sign in, manage workspaces, pay or start sessions while their requests fail. At
this rate the whole 30-day error budget is gone in about 2 days. Running sessions on the relay keep
working; new sessions may not start.

## Dashboards

- `$GRAFANA/d/centcom-api-overview?var-env=$ENV`: "5xx share", "Requests by status class",
  "Requests by route", "Availability burn rate, 1 h".
- `$GRAFANA/d/centcom-database-redis?var-env=$ENV`: "Pool saturation", "Redis errors", when the
  errors line up with a dependency.

## Triage commands

1. Which routes fail (Grafana Explore):
   `topk(5, sum by (route) (rate(centcom_http_requests_total{env="$ENV", status_class="5xx"}[5m])))`.
   One route points at its module; every route points at a dependency or the deploy.
2. Are the instances healthy and ready: `fly status -a centcom-$ENV-api`, then
   `curl -sS "$API/readyz"` (`checks.db`, `checks.redis`, `checks.migrations`).
3. Did a release start it: `fly releases -a centcom-$ENV-api` (compare the newest release time
   with the start of the "5xx share" rise).
4. Read the errors: `fly logs -a centcom-$ENV-api --no-tail | grep '"level":"error"' | tail -n 50`
   (look at `err.type` and `code`; never copy request bodies out).
5. Check the dependencies: the [DbPoolSaturation](DbPoolSaturation.md) and
   [RedisMemoryHigh](RedisMemoryHigh.md) signals on
   `$GRAFANA/d/centcom-database-redis?var-env=$ENV`, and the database and Redis provider status
   pages.

## Mitigation

- A release caused it: roll back to the previous image,
  `fly deploy -a centcom-$ENV-api --image <previous image from fly releases --image>` (B092's
  `infra/deploy/rollback.sh api` once it exists).
- One machine is bad (only its logs show the errors): `fly machine stop <machine id> -a centcom-$ENV-api`;
  the others take the traffic.
- Overloaded (latency up with the errors, pool saturated): add machines,
  `fly scale count <n + 2> -a centcom-$ENV-api`.
- A dependency is down: follow its runbook; the API answers 503 until it is back.

## Escalation

Page the secondary on-call if there is no mitigation within 30 minutes, and the platform team lead
for a dependency outage. Open a status incident ([status page procedure](../../../docs/ops/oncall.md#status-page-updates))
once customers have been affected for 5 minutes; you are the incident commander until you hand it
over.

## Verification

The 5xx share is back under 0.1 % and the 5-minute burn rate under 1:
`slo:burn_rate:5m{slo="api-availability", env="$ENV"}` in Grafana Explore. The alert has resolved:
`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=ApiAvailabilityFastBurn env=$ENV`
prints nothing.

## Post-incident

Resolve the status incident, write the postmortem ([template](../../../docs/ops/oncall.md#postmortems))
with the budget spent (`slo:sli_error:ratio_rate3d{slo="api-availability", env="$ENV"}`), and file
follow-ups for the cause and for anything in this runbook that was wrong or missing.
