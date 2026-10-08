# StripeWebhookLag

Severity: `page` (SLO burn, or the queue over 10 minutes old or 100 deep), `ticket` (3x over 3 d) ·
Service: `api` · Owner: `billing` · SLO: `stripe-webhook` (99 % of Stripe events processed within
30 s) · Rules: [api.rules.yaml](../../alerts/rules/api.rules.yaml)

## Symptoms

Stripe events are processed late: the `stripe-webhook` SLO burns 14.4x (1 h and 5 m) or 6x (6 h
and 30 m), or the `stripe.event.process` queue's oldest waiting event is over 10 minutes old, or
over 100 events wait. Support hears "I paid but I am still on Free" or "I removed seats but I am
still billed for them".

## Impact

Plan changes, seat counts and limits stay stale for paying customers until the events are
processed. No event is lost while it waits (Stripe retries for 3 days and stored events stay in
`stripe_event`), but dead-lettered ones need a replay ([DeadLetterNonEmpty](DeadLetterNonEmpty.md)).

## Dashboards

- `$GRAFANA/d/centcom-billing-stripe?var-env=$ENV`: "Stripe webhook burn rate, 1 h", "Stripe
  webhook lag p95 (B072)", "Entitlement revisions by cause".
- `$GRAFANA/d/centcom-workers-queues?var-env=$ENV`: "Queue depth", "Oldest waiting job",
  "Jobs failed" for `stripe.event.process`.

## Triage commands

1. Is the queue moving (Grafana Explore):
   `centcom_queue_depth{env="$ENV", queue="stripe.event.process"}` and
   `centcom_queue_oldest_age_seconds{env="$ENV", queue="stripe.event.process"}`.
2. Are events failing rather than waiting:
   `sum(rate(centcom_job_failed_total{env="$ENV", queue="stripe.event.process"}[5m]))`, and the
   dead letters: `redis-cli -u "$REDIS_URL" llen bull:stripe.event.dlq:wait`.
3. Is the consumer running: `fly status -a centcom-$ENV-api` and
   `fly logs -a centcom-$ENV-api --no-tail | grep stripe | grep '"level":"error"' | tail -n 50`.
4. Is Stripe itself delayed or failing to reach us: the endpoint's page under
   `https://dashboard.stripe.com/webhooks` shows failed deliveries and response codes, and
   `curl -sS https://status.stripe.com/api/v2/status.json` shows Stripe's own status.

## Mitigation

- The consumer is stuck or crashed: restart it, `fly machine restart <machine id> -a centcom-$ENV-api`.
- A backlog after an outage: add machines so the queue drains faster,
  `fly scale count <n + 2> -a centcom-$ENV-api`.
- Stripe cannot reach us (signature errors after a secret rotation): set both
  `STRIPE_WEBHOOK_SECRET` values again (B072 accepts two during a rotation), then resend failed
  events from the Stripe dashboard.
- Events dead-lettered: fix the cause, then replay them (B072's `replayEvent`).

## Escalation

Page the secondary on-call after 30 minutes. The billing team owns the processor; Stripe support
for delivery problems on their side. A status incident is warranted when plan changes are delayed
for more than 30 minutes.

## Verification

`centcom_queue_oldest_age_seconds{env="$ENV", queue="stripe.event.process"}` stays under 60 and the
queue depth under 10, and `slo:burn_rate:5m{slo="stripe-webhook", env="$ENV"}` is under 1; the
alert resolves (`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=StripeWebhookLag env=$ENV`).

## Post-incident

Check that every event received during the incident reached `processed` or `ignored` (billing
team), list workspaces whose entitlements were stale in the postmortem by count only (no ids in
tickets), and file follow-ups.
