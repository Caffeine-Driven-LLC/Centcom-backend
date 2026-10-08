# WebhookDeliveryFailing

Severity: `page` (the `webhook-delivery` SLO burning 14.4x over 1 h and 5 m, or 6x over 6 h and
30 m), `ticket` (over 50 % of attempts failing for 15 minutes, or 3x over 3 d) · Service: `worker` ·
Owner: `integrations` · SLO: `webhook-delivery` (95 % of first attempts answered within 10 s) ·
Rules: [worker.rules.yaml](../../alerts/rules/worker.rules.yaml)

## Symptoms

Outgoing webhooks (B081) fail or answer slowly on their first attempt, or most attempts fail.
Customers report integrations that stopped receiving events.

## Impact

Customers' integrations get events late; deliveries are retried with backoff, so they arrive late
rather than never while retries last. After the last retry they land in `webhook.dead`
([DeadLetterNonEmpty](DeadLetterNonEmpty.md)).

## Dashboards

- `$GRAFANA/d/centcom-workers-queues?var-env=$ENV`: "Webhook deliveries (B081)", "Webhook first
  attempt p95 (B081)", "Queue depth" for `webhook.deliver`.

## Triage commands

1. How attempts end (Grafana Explore):
   `sum by (result) (rate(centcom_webhook_deliveries_total{env="$ENV"}[5m]))`.
2. Is it every endpoint or a few: compare `result` over time; a sudden rise across all results that
   are not `ok` points at the sender, a slow climb at customers' endpoints. Check the sender's
   errors: `fly logs -a centcom-$ENV-worker --no-tail | grep webhook | grep '"level":"error"' | tail -n 50`.
3. Is the delivery queue backed up:
   `centcom_queue_oldest_age_seconds{env="$ENV", queue="webhook.deliver"}`.
4. Can the worker reach the internet: `fly ssh console -a centcom-$ENV-worker -C "wget -qO- -T 5 https://example.com"`
   prints a page.

## Mitigation

- The sender is broken by a release: roll back,
  `fly deploy -a centcom-$ENV-worker --image <previous image>`.
- Egress or DNS is down: check the Fly status page; deliveries resume and retry on their own.
- One large customer's endpoint is down: nothing to fix on our side; their deliveries retry and
  their webhook may be disabled by B081's failure policy.

## Escalation

The page: the secondary on-call after 30 minutes, the integrations team for the sender. The
ticket: the integrations team during working hours.

## Verification

`sum(rate(centcom_webhook_deliveries_total{env="$ENV", result="ok"}[5m])) / sum(rate(centcom_webhook_deliveries_total{env="$ENV"}[5m]))`
is back to its usual level and `slo:burn_rate:5m{slo="webhook-delivery", env="$ENV"}` is under 1.

## Post-incident

Record how many deliveries were delayed and how many dead-lettered (counts only), and whether the
failure was ours. Repeated customer-side failures that page are a sign the SLO should exclude
endpoints that are disabled; raise it with the integrations team.
