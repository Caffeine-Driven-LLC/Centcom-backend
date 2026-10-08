# Stripe webhooks (B072)

Ingests Stripe's webhooks safely: the signature is verified on the raw bytes, each event is stored
once, processed asynchronously and idempotently in any order, and plan changes reach entitlements
only through B070 (`upsertFromStripe`) and B069 (`applySubscriptionState`). Internal: Stripe
webhooks are not part of CT-API-BILLING, so the endpoint stays out of public docs.

## Pieces

| File                                  | What it does                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `routes/stripe-webhook/index.ts`      | `POST /internal/stripe/webhook`: raw body (`plugins/raw-body.ts`, 1 MiB), no user auth, 200 / 400 / 500.   |
| `ingest.ts`                           | `WebhookIngest.handle(rawBody, sigHeader, now)`: verify (B070 `constructEvent`), store once, queue.        |
| `store.ts`                            | `stripe_event`: insert once, claim, finish, release, waiting.                                              |
| `handlers.ts`                         | Per-type rules, and `reduceObject` (what is kept of an event's object).                                    |
| `processor.ts`                        | `EventProcessor.process(eventId)` and `replayEvent(eventId)`.                                              |
| `outbox.ts`                           | `billing_outbox` and `publishOutbox` (B081 webhooks, B063 `billing_issue`).                                |
| worker `jobs/stripe-event-process.ts` | Queue `stripe.event.process` (8 attempts, exponential backoff with jitter), DLQ `stripe.event.dlq`, sweep. |

## Flow

1. **Receive.** `Stripe-Signature` is checked on the exact bytes before parsing: HMAC-SHA256,
   constant-time compare, 300 s tolerance. While the endpoint's secret is rolled, either of the two
   secrets in `STRIPE_WEBHOOK_SECRET` verifies. A bad, stale or tampered delivery is 400 and
   nothing is stored.
2. **Store.** One insert into `stripe_event`, unique on the event id, with a reduced copy of the
   object (ids, status, amounts, currency), so a duplicate delivery does nothing. Handled types are
   stored `received`, others `ignored`. Then 200 `{received: true}`. If the insert fails the answer
   is 500, so Stripe delivers again: nothing is acknowledged that isn't stored.
3. **Queue.** A newly stored handled event is queued with its event id as the job id. If queueing
   fails, the sweep picks the event up.
4. **Process.** The worker claims the event and runs its handler:

   | Event                                           | What it does                                                                                                                      |
   | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
   | `customer.subscription.created/updated/deleted` | re-fetch the subscription from Stripe, `upsertFromStripe` (stale guard on `created`)                                              |
   | `checkout.session.completed`                    | the same for its subscription; ignored without one                                                                                |
   | `invoice.paid`                                  | reconcile; outbox `billing.invoice.paid`                                                                                          |
   | `invoice.payment_failed`                        | reconcile (`past_due_since` set once by B070); outbox `billing.invoice.payment_failed` and one `notify.billing_issue` per invoice |
   | anything else                                   | `ignored`                                                                                                                         |

   A reconcile that B070 applied also writes `billing.subscription.updated`.

5. **Publish.** After a success, and on every sweep, outbox rows go out in id order and are marked
   published, at least once (B081 and B063 de-duplicate).

**Outcomes:**

- A subscription of no known workspace is `failed` / `unknown_customer`; an unknown plan is
  `failed` / `unknown_plan`. Neither is retried.
- Any other failure is retried: Stripe down is `stripe_unavailable`, B069 or the database
  `handler_error`. After the 8th attempt the event is `failed` and the job is copied to
  `stripe.event.dlq`.
- `replayEvent(eventId)` reprocesses a stored event in any status. Handlers are idempotent, so
  this is safe.

## Config

- `STRIPE_WEBHOOK_SECRET`: one `whsec_…`, or two separated by a comma while rolling the
  endpoint's secret (B070's loader checks both).
- The rest is B070's Stripe config.
- Constants: 1 MiB body limit, 300 s tolerance, 8 attempts with backoff from 2 s and 50 % jitter.
  The sweep runs every minute, requeues events after 1 min, and alerts after 10 min.

## Failure modes

| Failure                      | Behaviour                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Database down at ingest      | 500; Stripe redelivers.                                                                                                           |
| Queue down at ingest         | 200 (stored); the sweep queues it; `stripe_event_enqueue_failures_total`.                                                         |
| Stripe down while processing | Retried with backoff; `received` / `processing` meanwhile; `stripe_events_stale_total` and a warning when the oldest is > 10 min. |
| B069 error                   | Retried; B070's upsert is idempotent, so a stored subscription row is safe.                                                       |
| Outbox publish fails         | The row stays unpublished; the next run or sweep retries it.                                                                      |

**Privacy:** Centcom never stores, logs or returns card data, e-mail addresses, names, addresses,
the signature header or the secret. Logs carry the event id and type, outcomes and error codes.

## Wiring

```ts
const events = createStripeEventStore(db);
const outbox = createOutboxStore(db);
const publish = () => publishOutbox({ outbox, emitWebhook, notify: dispatcher, logger, metrics });
const processor = new EventProcessor({
  events,
  outbox,
  gateway,
  billing,
  workspaceOfCustomer: (id) => billingRepository.workspaceOfCustomer(id),
  publish,
  logger,
  metrics,
});
const ingest = new WebhookIngest({
  gateway,
  events,
  queue: { enqueue: (id) => enqueueStripeEvent(stripeQueue, id) },
  logger,
  metrics,
});
await app.register(stripeWebhookRoutes, { ingest }); // after request-context and error-handler
// worker: startStripeEventWorker({ ..., process: (id, o) => processor.process(id, o),
//   waiting: events.waiting, oldestWaiting: events.oldestWaiting, publish, queue, dlq })
```

## Tests

All in `apps/api/test/billing/webhooks/`:

- `webhook.signature`: valid, tampered, stale, rotated secrets, size limit.
- `webhook.idempotency`: duplicates and concurrent deliveries.
- `webhook.ordering`: out-of-order events, including a fast-check property.
- `webhook.handlers`: each event type, the outbox, B081 checks.
- `webhook.retry-dlq`: retries and replay.
- `webhook.privacy`: logs and rows, plus the Postgres stores.

The job's side is in `apps/worker/test/stripe-event-process.test.ts`.
