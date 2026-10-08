# Checkout and billing portal (B071)

Hosted Stripe Checkout and Customer Portal sessions for a workspace
([CT-API-BILLING](../../../../../../contracts/02-rest-api.md), `createCheckout` and
`createPortalSession`). Stripe hosts both pages and collects the card; this module decides what
is sold and where the customer comes back, never anything a client says about either.

## Endpoints

| Endpoint                            | Who                                   | Idempotency-Key | Answer                  |
| ----------------------------------- | ------------------------------------- | --------------- | ----------------------- |
| `POST /v1/workspaces/{id}/checkout` | owner, billing; scope `billing:write` | required        | 201 `{url, expires_at}` |
| `POST /v1/workspaces/{id}/portal`   | owner, billing; scope `billing:write` | accepted        | 200 `{url}`             |

Admins, members, guests and tokens without `billing:write` get 403 `forbidden`; anyone else 404. Both write one audit event (`billing.checkout` with plan, interval and seats;
`billing.portal` with the plan), never a URL or a Stripe id. Every answer of both is
`Cache-Control: no-store`, replays included (a route hook: B024 replays only content headers).

### Checkout

- **Body:** `plan` (`pro` or `team`), `interval` (`month` or `year`), `currency` (`USD` or `EUR`,
  default `USD`), `seats` (team: 5 to `BILLING_MAX_SEATS`, default 5; pro: 1). A plan, interval,
  currency or seat count outside these is 422 with `errors[].pointer` for each field.
  `success_url`, `cancel_url` and `return_url` are ignored: they are never read, forwarded or
  refused.
- **Prices** come from B070's catalogue (`STRIPE_PRICE_*`): the plan's price, plus team seats
  above the 5 included at the seat price. A combination the catalogue does not price is 422.
- **Refused when a subscription is in effect** (active, trialing or past due): 409 `conflict`.
  Plan and seat changes go through the portal (and B073). A canceled subscription may check
  out again.
- **The customer** is B070's `ensureCustomer`: created once, reused on every retry.
- **The session** is subscription-mode, with `client_reference_id` and `metadata.workspace_id`
  (also on the subscription, for B072's webhooks) set to the workspace and automatic tax on.
  `expires_at` is Stripe's.
- **Idempotency:** B024 replays a repeated key and body (`Idempotency-Replayed: true`, no second
  Stripe session) and refuses the key with another body (409 `idempotency_conflict`). The stored
  answer holds the session URL, so it is kept encrypted. Stripe's own idempotency key is
  `centcom-<workspace>-checkout-<digest>`, the digest a SHA-256 of the caller, the client's key
  and the request. A retry after a 503 (which B024 does not store) gets the same session; another
  caller or request never does.
- **No entitlement changes here:** the plan changes when B072 processes Stripe's webhook.

### Portal

- A session for the workspace's existing Stripe customer. Without one it is 404, and none is
  created.
- Any status may use it, past due included (that is where the card is fixed).
- The body's `return_url` is ignored.

### Return URLs

`redirects.ts` builds them from `WEB_BASE_URL` (default `https://centcom.dev`), the CT-DEEPLINK
"Upgrade / billing" page:

| Kind               | URL                                            |
| ------------------ | ---------------------------------------------- |
| `checkout_success` | `https://centcom.dev/billing?checkout=success` |
| `checkout_cancel`  | `https://centcom.dev/billing?checkout=cancel`  |
| `portal_return`    | `https://centcom.dev/billing`                  |

Stripe returns to web pages only; the page hands the user on to the app (`appRedirect`:
`centcom://billing?checkout=success` and so on). CT-DEEPLINK clients ignore the unknown
`checkout` parameter.

## Configuration

| Key                 | Default               | Rule                                              |
| ------------------- | --------------------- | ------------------------------------------------- |
| `BILLING_MAX_SEATS` | `500`                 | 5 to 100 000: the most seats a team checkout buys |
| `WEB_BASE_URL`      | `https://centcom.dev` | B033's; the origin of the return URLs             |

Stripe's keys and prices are B070's (see `../README.md`).

## Failure modes

The 503 and 502 below are the session calls' (the checkout or portal session itself):

- **Stripe unreachable** (after the client's retries): 503 with `retry_after_s` 30. The client
  retries with the same Idempotency-Key and gets the same session.
- **Stripe refuses the request** (a 4xx: a price it does not know, a revoked key, an unreadable
  answer): a configuration fault. 502 `bad_gateway` with a generic detail, never Stripe's message.
  It is counted (`billing_session_failures_total{kind, reason}`) and logged as an error
  (`billing.session_failed`, with Stripe's error kind, status and code only).
- **Finding or creating the customer** (a workspace's first checkout) is B070's `ensureCustomer`,
  with B070's answers: a Stripe refusal there is its 500 `internal_error`, an outage its 503.
  Neither is counted in `billing_session_failures_total` or logged as `billing.session_failed`.
- **No one to bill** (no owner or billing contact): B070's 404.

## Observability

- `billing_sessions_created_total{kind}`, where kind is `checkout` or `portal`.
- `billing_session_failures_total{kind, reason}`, where reason is `stripe_unavailable` or
  `stripe_refused`.
- Log events: `billing.session_unavailable` (warn) and `billing.session_failed` (error). Never a
  session URL, a session id or a customer id.

## Tests

`apps/api/test/billing/checkout/`:

- **`checkout.authz`:** role × scope matrix on both endpoints, and API keys.
- **`checkout.idempotency`:** missing key, replay, conflict, and the derived Stripe key across
  retries, callers and requests.
- **`checkout.redirects`:** client URLs ignored; configured URLs only.
- **`checkout.validation`:** plan, interval, currency and seats; catalogue prices; BILLING_MAX_SEATS.
- **`checkout.portal`:** no customer, the checkout's 201 body, past due, subscriptions in effect,
  nothing granted, and Stripe failures (503, 502).
- **`checkout.audit`:** one event each, no URLs or ids in audit or logs, replays, refusals.
- **`checkout.stripe`:** the exact Stripe requests through `StripeClient` against a local
  stand-in.
