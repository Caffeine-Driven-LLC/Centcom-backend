# Billing (B070)

A workspace's Stripe customer and subscription, and `GET /v1/workspaces/{id}/subscription`
([CT-API-BILLING](../../../../../contracts/02-rest-api.md)). Stripe holds cards, addresses and tax
ids; Centcom stores Stripe ids and the subscription's state, nothing more. Entitlements come
from B069; billing hands it each applied subscription and never decides what a plan allows.

## Pieces

| File                          | What it does                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stripe/gateway.ts`           | `StripeGateway`, the parsed shapes (`StripeSub`, `StripeEvent`), `StripeError`, `idempotencyKey`.           |
| `stripe/stripe-client.ts`     | `StripeClient` over Stripe's REST API (pinned version, retries, webhook signatures) and `loadStripeConfig`. |
| `stripe/status-map.ts`        | `mapStripeStatus`: Stripe status → contract status.                                                         |
| `stripe/price-catalog.ts`     | `loadPriceCatalog`: plans and seat add-ons → Stripe price ids, and back.                                    |
| `subscriptions/repository.ts` | `billing_customer` and `billing_subscription`.                                                              |
| `subscriptions/service.ts`    | `BillingService`: `ensureCustomer`, `getSubscription`, `upsertFromStripe`.                                  |
| `checkout/`                   | B071: `CheckoutService` (hosted checkout and billing portal sessions) and the return URLs; see its README.  |
| `webhooks/`                   | B072: Stripe webhook ingestion, processing and the billing outbox; see its README.                          |

Routes: `routes/subscription/index.ts`; B071's `routes/checkout/index.ts` and `routes/portal/index.ts`.

## Customers

`ensureCustomer(workspaceId)` returns the workspace's Stripe customer, creating it once:

1. the stored link, else a customer Stripe already has for the workspace (found by its
   `workspace_id` metadata, if a create succeeded but its link was lost);
2. else Stripe creates one, with the billing contact's e-mail and locale (the earliest
   `billing` member, else the owner) and the idempotency key
   `centcom-<workspace>-customer-create`, so concurrent and retried calls get the same customer;
3. the link is written only after Stripe answered, so a failed call leaves no row.

Concurrent calls in one process share one attempt. If Stripe stays unreachable through the
client's retries, the call is a 503 with `retry_after_s`; if Stripe refuses it, a 500.

## Subscriptions

- **`upsertFromStripe(sub, eventCreated)`** stores the Stripe subscription unless a newer event
  already did (`stripe_event_created`, the stale-event guard). An equal timestamp is applied
  again.
  - Plan, interval and add-on seats come from the price catalogue. `seats` is the plan's included
    seats (pro 1, team 5) plus add-on seats (team only).
  - A currency other than the stored one is stored as returned, with a warning.
  - An unknown plan price keeps the stored plan (or is a `BillingStateError` for a new
    subscription). A customer of no workspace is a `BillingStateError` too.
  - Applied states go to B069's `applySubscriptionState`.
- **`getSubscription`** reads the database only.
- **Status:**

  | Stripe                                                     | Contract   |
  | ---------------------------------------------------------- | ---------- |
  | `active`                                                   | `active`   |
  | `trialing`                                                 | `trialing` |
  | `past_due`, `unpaid`                                       | `past_due` |
  | `canceled`                                                 | `canceled` |
  | `incomplete`, `incomplete_expired`, `paused`, anything new | `none`     |

  An unknown status is logged as a warning.

## `GET /v1/workspaces/{id}/subscription`

- Scope `billing:read`, roles owner, admin and billing (B021 RBAC `billing.read`, roles from the
  database). Members and guests get 403, others 404. An API key needs `billing:read` and its own
  workspace.
- The answer is the contract's `Subscription`: our `sub_` id, plan, status, seats, interval,
  currency, period, `cancel_at_period_end`, `trial_end` (trialing only) and `grace_until`
  (past_due: 7 days after it began). It never includes a Stripe id, card detail or e-mail.
- A workspace with no subscription in effect (none, or status `none`) is 404 `not_found`; it is
  on the free plan.
- It never calls Stripe, so it keeps working while Stripe is down.

## Stripe client

- **Version:** `Stripe-Version: 2025-03-31.basil` unless `STRIPE_API_VERSION` says otherwise.
  Subscription periods are read from items (this version) or the subscription (older ones).
- **Requests:** form-encoded, with a 10 s timeout and the caller's `Idempotency-Key` on writes.
- **Retries:** network errors, timeouts, 409, 429, 5xx and `Stripe-Should-Retry: true` are tried
  3 more times, with full-jitter backoff (500 ms base, 5 s cap) and the same key. After that the
  error kind is `unavailable`. Other 4xx fail at once (`request`, `auth`).
- **Webhooks:** `constructEvent` verifies `Stripe-Signature` (HMAC-SHA256, any `v1`, 300 s
  tolerance) against each configured secret (two while rolling) for B072; see `webhooks/README.md`.

## Configuration

| Key                                                       | Notes                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`                                       | `sk_…`/`rk_…`; required in production. Without it (elsewhere) billing is off.  |
| `STRIPE_API_VERSION`                                      | Default `2025-03-31.basil`.                                                    |
| `STRIPE_WEBHOOK_SECRET`                                   | `whsec_…`, for B072's webhook; two, comma-separated, while rolling the secret. |
| `STRIPE_API_BASE`                                         | Default `https://api.stripe.com` (stripe-mock in tests).                       |
| `STRIPE_PRICE_<PRO\|TEAM\|SEAT>_<MONTH\|YEAR>_<USD\|EUR>` | Stripe price ids, all 12 required in production; no id may sell two things.    |

## Wiring

```ts
const stripe = loadStripeConfig();
const billing = new BillingService({
  repository: createBillingRepository(db),
  gateway: new StripeClient({ config: stripe }), // when stripe !== null
  catalog: loadPriceCatalog(),
  entitlements: entitlementService, // B069
  logger,
  metrics,
});
await app.register(subscriptionRoutes, { billing }); // after the auth and RBAC plugins
// B071: checkout and portal (also after the idempotency and audit plugins).
const checkout = new CheckoutService({
  gateway, // the same StripeClient
  billing,
  repository,
  catalog,
  config: loadCheckoutConfig(),
  logger,
  metrics,
});
await app.register(checkoutRoutes, { checkout });
await app.register(portalRoutes, { checkout });
```

## Tests

`apps/api/test/billing/subscriptions/`:

- `billing.customer`: concurrency and idempotency, with a Postgres variant.
- `billing.status-map`: the full mapping.
- `billing.subscription-route`: authorisation, the response shape and privacy.
- `billing.gateway.stripe-mock`: HTTP-level calls and retries against a local stand-in, and
  against stripe-mock when `STRIPE_MOCK_URL` is set.
- `billing.catalog`: configuration checks.
- `billing.stale-guard`: the stale-event guard, with a Postgres variant.
