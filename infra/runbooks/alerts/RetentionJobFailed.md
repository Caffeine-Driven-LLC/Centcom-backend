# RetentionJobFailed

Severity: `ticket` · Service: `retention` · Owner: `platform` · Metrics:
`centcom_retention_aborted_total` (B090; until it lands the rule is non-prod only) and
`centcom_telemetry_retention_failed_total` (B085) · Rules:
[retention.nonprod.rules.yaml](../../alerts/rules/retention.nonprod.rules.yaml)

## Symptoms

In the last hour a data-retention run aborted (B090's brake: it would have deleted more than 20 %
of a table in one run) or a telemetry retention run failed for good (B085).

## Impact

Nothing customers see. Data past its retention period stays longer than the policy says, which is
a privacy commitment (GUIDELINES §5.7), and the next run has more to delete.

## Dashboards

- `$GRAFANA/d/centcom-workers-queues?var-env=$ENV`: "Jobs failed" and "Job duration p95" for the
  retention queues.

## Triage commands

1. Which policy and why (Grafana Explore):
   `sum by (policy) (increase(centcom_retention_aborted_total{env="$ENV"}[1h]))` and
   `sum(increase(centcom_telemetry_retention_failed_total{env="$ENV"}[1h]))`.
2. The run report: `psql "$DATABASE_URL" -c "select policy, started_at, scanned, purged, aborted_reason from retention_runs order by started_at desc limit 10"`.
3. The worker's errors: `fly logs -a centcom-$ENV-worker --no-tail | grep retention | grep '"level":"error"' | tail -n 20`.

## Mitigation

- `fraction_exceeded`: check that the policy's cut-off is right (a wrong clock or a plan change can
  make a large share legitimately old). When it is right, run once with `RETENTION_FORCE=true`
  (B090) and record who approved it; when it is wrong, fix the policy.
- A failed telemetry retention run: it retries on the next schedule; fix the error from step 3.

## Escalation

A ticket for the platform team. The privacy owner is told if data stays past its period for more
than a week.

## Verification

The next scheduled run shows in step 2 without `aborted_reason`, and the counters in step 1 stop
increasing.

## Post-incident

Record what was kept too long and for how long, by dataset (no ids).
