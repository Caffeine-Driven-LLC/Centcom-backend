# DeadLetterNonEmpty

Severity: `page` · Service: `worker` · Owner: `platform` · Rules:
[worker.rules.yaml](../../alerts/rules/worker.rules.yaml)

## Symptoms

A dead-letter queue (`notify.dispatch.dlq`, `stripe.event.dlq`, `webhook.dead`, any BullMQ queue
named `*.dlq` or `*.dead`) has held at least one job for 15 minutes. A job lands there after it
failed every retry. (Jobs dead-lettered into a queue's failed set are counted by their own
failure metrics, not by this alert.)

## Impact

Work that customers expect has not happened: a Stripe event not applied (plan or seats stale), a
notification not sent, an outgoing webhook not delivered. Dead letters are kept 7 days and then
lost, so this is a data-loss risk, which is why it pages.

## Dashboards

- `$GRAFANA/d/centcom-workers-queues?var-env=$ENV`: "Queue depth" (the dead-letter queue), "Jobs
  failed" (its source queue), "Oldest waiting job".

## Triage commands

1. Which queue and how many (Grafana Explore):
   `centcom_queue_depth{env="$ENV", queue=~".+[.](dlq|dead)"}`.
2. When did the source queue start failing:
   `sum by (queue) (rate(centcom_job_failed_total{env="$ENV"}[5m]))`.
3. Look at the dead letters (ids and how they failed only; never paste job data elsewhere):
   `redis-cli -u "$REDIS_URL" lrange bull:<queue>:wait 0 9`, then for one id
   `redis-cli -u "$REDIS_URL" hget bull:<queue>:<job id> data | jq '{error, attempts, failedAt}'`
   (`notify.dispatch.dlq` records the error kind, the attempts and the time).
4. Read the worker's errors for that queue:
   `fly logs -a centcom-$ENV-worker --no-tail | grep '<source queue>' | grep '"level":"error"' | tail -n 50`.

## Mitigation

- Fix the cause first (a dependency down, a provider rejecting calls, a bug in a release), or the
  replayed jobs fail again.
- Replay: `stripe.event.dlq` with B072's `replayEvent`; `notify.dispatch.dlq` and `webhook.dead` by
  moving the jobs back to their source queue with BullMQ (a worker shell), oldest first.
- A known-bad job that must never run (for example a deleted workspace): remove it,
  `redis-cli -u "$REDIS_URL" lrem bull:<queue>:wait 1 <job id>`, and note it in the incident.

## Escalation

Page the secondary on-call after 30 minutes. The billing team for `stripe.event.dlq`, the
integrations team for `webhook.dead`, the platform team for the rest.

## Verification

`centcom_queue_depth{env="$ENV", queue="<queue>"}` is 0 and the source queue's failures are back to
normal (step 2); the alert resolves
(`amtool --alertmanager.url="$ALERTMANAGER_URL" alert query alertname=DeadLetterNonEmpty env=$ENV`).

## Post-incident

Count the jobs replayed and removed (counts, not ids) in the postmortem. A recurring dead letter
needs a fix in the job, not a habit of replaying.
