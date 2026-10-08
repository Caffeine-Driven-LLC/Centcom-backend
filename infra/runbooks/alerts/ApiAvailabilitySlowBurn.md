# ApiAvailabilitySlowBurn

Severity: `page` (6x over 6 h and 30 m), `ticket` (3x over 3 d) · Service: `api` · Owner:
`platform` · SLO: `api-availability` (99.9 %) · Rules: [api.rules.yaml](../../alerts/rules/api.rules.yaml)

## Symptoms

- Page: at least 0.6 % of API requests answered 5xx over the last 6 hours and the last 30 minutes
  (burn rate 6).
- Ticket: at least 0.3 % over the last 3 days and the last 6 hours (burn rate 3).

Nothing is down; a steady share of requests fails. Support sees occasional errors that "go away on
retry".

## Impact

A slice of customers hits errors all the time: one route, one region or one instance is usually
broken while the rest works. The page means the 30-day budget is gone in 5 days, the ticket in 10.

## Dashboards

- `$GRAFANA/d/centcom-api-overview?var-env=$ENV`: "5xx share" over 7 days, "Requests by route",
  "Latency p95 by route".

## Triage commands

1. Find the failing slice (Grafana Explore, 6 h range):
   `sum by (route, method) (rate(centcom_http_requests_total{env="$ENV", status_class="5xx"}[30m]))`.
2. Compare regions: `sum by (region) (rate(centcom_http_requests_total{env="$ENV", status_class="5xx"}[30m]))`;
   one region points at its machines (`fly status -a centcom-$ENV-api`).
3. Did it start with a release: `fly releases -a centcom-$ENV-api`.
4. Read the failing requests: the access log has one line per request with `route` (the
   template) and `status`, so
   `fly logs -a centcom-$ENV-api --no-tail | grep '"route":"<route template>"' | grep '"status":5' | tail -n 20`,
   then follow one `request_id` to its error line: `fly logs -a centcom-$ENV-api --no-tail | grep '<request id>'`.

## Mitigation

- A bad release: roll back as in [ApiAvailabilityFastBurn](ApiAvailabilityFastBurn.md#mitigation).
- One bad machine or region: `fly machine stop <machine id> -a centcom-$ENV-api`.
- One broken feature behind a flag: turn the flag off through the admin API
  (`PUT /internal/admin/v1/flags/<key>`, see `docs/admin/admin-api.md`).
- A ticket with no urgent cause: fix it in the normal sprint; note the budget spent.

## Escalation

For the page: the secondary on-call after 30 minutes without a lead, the platform team for a code
fix. For the ticket: assign it to the platform team; no out-of-hours work.

## Verification

`slo:burn_rate:30m{slo="api-availability", env="$ENV"}` drops under 1 within half an hour of the
fix, and the alert resolves:
`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=ApiAvailabilitySlowBurn env=$ENV`.

## Post-incident

Record the budget spent (`slo:sli_error:ratio_rate3d{slo="api-availability", env="$ENV"}`) in the
postmortem or ticket. If the slice was a single customer's traffic pattern, say so: it may need a
rate limit rather than a fix.
