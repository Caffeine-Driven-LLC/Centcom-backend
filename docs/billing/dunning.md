# Dunning (B078)

What happens when a payment fails: the workspace keeps its plan for a 7-day grace, is reminded
on grace days 0, 3 and 6, returns to `active` when it pays, and drops to `none` (free) when it
does not; a canceled subscription drops to `none` at the end of its period. Live hosted sessions
end 10 minutes after a drop. Nothing is deleted at any step
([CT-ENTITLEMENTS](../../contracts/07-billing-entitlements.md) §4 and §7), and LAN and local use
never change.

Code: `apps/api/src/modules/billing/dunning/` (state machine, service, repository) and the worker's
`apps/worker/src/jobs/dunning/` (queue, jobs, scheduler). Table: migration
`packages/db/migrations/20260102004300_subscription_dunning.sql`.

## States

| Dunning state \ subscription now | `active` / `trialing` | `past_due`             | `canceled`                          | `none` (or no subscription) |
| -------------------------------- | --------------------- | ---------------------- | ----------------------------------- | --------------------------- |
| no row (taken as `active`)       | nothing               | → `past_due`           | → `canceled` (no end: quiet `none`) | quiet `none`                |
| `active` / `trialing`            | → the other, if other | → `past_due`           | → `canceled` (no end: none)         | → `none`                    |
| `past_due`                       | → it (recovered)      | nothing (grace kept)   | → `canceled` (no end: none)         | → `none`                    |
| `canceled`                       | → it (resubscribed)   | → `past_due`           | nothing (new end kept)              | → `none`                    |
| `none`                           | → it (recovered)      | nothing (still unpaid) | nothing                             | nothing                     |

Plus the clock: `past_due` drops to `none` once `grace_until` has passed, `canceled` once its
`period_end` has passed (strictly after, as B069's resolver keeps the plan up to and including the
end). Before dropping, the expiry job re-checks the subscription: one that is `active` or
`trialing` again, or `canceled` with a period that ends later (the event that said so never
reached dunning), is followed instead.

A drop is stamped with the time dunning applies it (never an event's own, older, time), so the
wind-down always comes 10 minutes after. The first event of a workspace whose subscription is
`active` writes an `active` row (no transition), so a workspace with no row has had no dunning
event while paying: when its subscription ends (B070 says `none`, or `canceled` with no period)
it is recorded `none` quietly, already announced and with no transition, so it gets no
`plan_changed` notice.

- **Which status counts:** dunning follows the subscription's current status. B072 re-fetches the
  subscription from Stripe before handing an event over, so B070's row is Stripe's present state in
  whatever order events arrive: an old `invoice.payment_failed` that comes after the
  `invoice.paid` that settled it finds the subscription `active` and changes nothing.
- **The grace** ends exactly 7 days (168 hours) after `first_failed_at`: the time B070 recorded the
  subscription past due, or earlier when the event itself shows the failure
  (`invoice.payment_failed`, or a subscription event whose payload is `past_due` or `unpaid`) and
  was created at most 3 days before that (Stripe retries an undelivered webhook for up to 3
  days). So a failure webhook processed late does not lengthen the grace, and an old event that
  does not show a failure (a seat change made while active, a payment), processed after the
  subscription went past due, never shortens it. A failure-showing event created up to 3 days
  earlier does move the start, even one of an earlier failure settled in between: the 3-day
  window bounds that. B070's `past_due_since` is moved back to
  `first_failed_at` when it was later, and entitlements are re-applied (every time, so a retried
  event finishes a re-apply that failed) so that B069's `grace_until` is the same instant. A
  second failure moves nothing. A later `invoice.payment_failed` showing an earlier failure than
  the one recorded does not move the start back either: the email already told the date.
- **Entitlements** change only through B070 and B069: they move `rev` when Stripe's status
  changes (once for `past_due`, once for the payment), and B069 resolves the drop to `none` itself,
  moving `rev` in the transaction that writes the status. Dunning reads the entitlements to make
  B069 do that at the drop, and never writes a status of its own into them.

## Events

B072's handlers call `applyBillingEvent(ev, now)` after reconciling, for
`invoice.payment_failed`, `invoice.paid`, `customer.subscription.updated` and
`customer.subscription.deleted`. The change is decided under a transaction-scoped advisory lock on
the workspace and written with its `billing.status` audit event (meta `from`, `to`, and `reason`
for a drop) in one transaction. What follows is done whether or not the call changed anything, so
a retried event finishes what a failed one started: in `past_due`, the alignment of
`past_due_since` and the reminders due; on leaving `past_due`, the cancellation of that failure's
queued reminders; in `none`, the announcement if it has not happened.

An event whose customer maps to no workspace never reaches dunning: B072 records it `failed`
(`unknown_customer`) and nothing changes.

## Jobs (`dunning` queue)

| Job                                        | When                                  | What                                                                                             |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `expire {}`                                | every 5 minutes                       | drops ended graces and periods to `none`, announces drops, queues due reminders                  |
| `remind {workspaceId, day, firstFailedAt}` | at `first_failed_at` + 0, 3 or 6 days | the day's reminder, if the same failure is still `past_due` and the day was not sent             |
| `wind-down {workspaceId}`                  | 10 minutes after a drop               | ends the live hosted sessions (SessionEnder port) if the workspace is still `none`, else nothing |

- **Catching up:** `expire` works in batches of 200, oldest first, until a batch comes back
  short (at most 25 batches a run; the next run goes on); the reminder scan pages on by failure
  time, as queuing a reminder does not change its row. After hours without a scheduler, the first
  run drops every overdue workspace and queues every missed reminder.
- **Announcing a drop:** reads the entitlements (B069 resolves `none` and moves `rev` on); when they
  say `none`, adds a `billing.subscription.updated {plan, status: 'none', seats}` webhook to
  B072's outbox and queues one `wind-down` job 10 minutes later (both once per drop: the outbox
  key and the job id), then claims the drop (marks it announced, unless someone did) and only then
  publishes `sys.notice plan_changed {plan: 'free'}` (level `info`) on `relay:notice:{wsp}`. Two
  runs announcing at once publish one notice; a worker that dies between the claim and the publish
  sends none (at most once, like the pub/sub channel itself). Entitlements that do not say `none`
  yet leave it for the next run (logged `dunning.announce_deferred`).
- **Retries:** `remind` and `wind-down` get 5 attempts, exponential backoff from 10 s with 50 %
  jitter; after the last they are copied to `dunning.dead` (kept 14 days) and counted in
  `dunning_dead_letters_total{job}`. A failed `expire` run is not retried: the next one does the
  same work. Completed jobs are kept a day, so a job id queued again within the day does nothing.

## Reminders

| Grace day | To members (owner, billing): `billing_issue {kind: payment_failed}` | To the billing contact: email |
| --------- | ------------------------------------------------------------------- | ----------------------------- |
| 0         | B072's, requested once per failed invoice                           | `billing_payment_failed`      |
| 3         | dunning's, through B072's outbox (dedupe key per failure and day)   | `billing_payment_failed`      |
| 6         | dunning's, the same way                                             | `billing_payment_failed`      |

B063 delivers `billing_issue` to the inbox and by email at once (its defaults; quiet hours never
hold it back). The email goes to the workspace's billing contact (its earliest billing member, else
its owner) through B032, like B079's trial-ending email, with the workspace's name and when the
grace ends: no amount, card, invoice or Stripe id. Each day is sent once: the row keeps a bit per
day (`reminders_sent`), and the outbox key and the email's idempotency key make a retried job send
nothing twice. Either send failing does not stop the other; the job is retried for the one that
failed. A reminder for a failure that was paid, or that already dropped to `none`, sends nothing.

## Configuration

| Key                    | Default | Meaning                                                                                                     |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `DUNNING_GRACE_DAYS`   | 7       | Grace days of a failed payment. CT-ENTITLEMENTS fixes 7; anything else is refused at start.                 |
| `DUNNING_WINDDOWN_MIN` | 10      | Minutes live hosted sessions keep running after a drop. CT-ENTITLEMENTS fixes 10; anything else is refused. |

## Metrics and logs

| Metric                       | Labels                                               |
| ---------------------------- | ---------------------------------------------------- |
| `dunning_transitions_total`  | `from`, `to`                                         |
| `dunning_reminders_total`    | `day`, `outcome` (sent, stale, sent_before, not_due) |
| `dunning_wind_downs_total`   | `outcome` (ended, skipped)                           |
| `dunning_dead_letters_total` | `job` (recorded only on failure)                     |

Logs carry workspace ids, states, days, counts and error kinds: never invoice or customer ids,
amounts or addresses.

## Wiring

```ts
const dunning = new DunningService({
  repository: createDunningRepository(
    db,
    createAuditEmitter({ db, actions: DUNNING_AUDIT_ACTIONS }),
  ),
  entitlements, // B069's EntitlementService
  billing: createBillingRepository(db), // B070 (billing contact)
  outbox: createOutboxStore(db), // B072
  notices: redis.pubsub, // B009
  scheduler: createDunningScheduler(createDunningQueue({ connection, prefix })), // @centcom/worker
  sessions: sessionEnder, // adapter over B053's lifecycle service: end live hosted sessions
  config: loadDunningConfig(),
  mail: emailService, // B032
  logger,
  metrics,
});
// B072's handlers: pass `dunning` (and `clock`) in the EventProcessor's deps.
await scheduleDunningExpire(createDunningQueue({ connection, prefix }));
startDunningWorker({
  connection,
  prefix,
  runner: dunning,
  dlq: createDunningDlq({ connection, prefix }),
  logger,
  metrics,
});
```
