# Billing: going live, and running without it

Two modes, chosen by environment (`infra/deploy/production.env`):

| Mode                     | Settings                                                          | What happens                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No billing** (default) | `STRIPE_SECRET_KEY` empty; optional `SELF_HOST_PLAN`              | The checkout, portal, subscription and webhook routes are left out (one log line). New personal workspaces start on `SELF_HOST_PLAN` (`free`, `pro` or `team`; empty means Free). Dev uses `DEV_DEFAULT_PLAN`. |
| **Stripe**               | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, 12 `STRIPE_PRICE_*` | The routes exist, the API stores signed webhooks, the worker processes them, and a paid subscription changes the workspace's entitlements. `SELF_HOST_PLAN` is refused (plans are sold, not given).            |

`SELF_HOST_PLAN` applies to workspaces created after it is set. For existing ones:
`insert into workspace_entitlements (workspace_id, plan_id, status) values ('wsp_...', 'team', 'active') on conflict (workspace_id) do update set plan_id = 'team', status = 'active';`

## What the code does (verified by `apps/api/test/entrypoint/billing.e2e.test.ts`, on Postgres)

- `POST /v1/workspaces/{id}/checkout`: owner or billing member, `Idempotency-Key` required, priced from
  the server's catalogue only, `success_url`/`cancel_url` in the body ignored; 409 when a subscription
  is already in effect; 404 for a stranger.
- `POST /v1/workspaces/{id}/portal`, `GET /v1/workspaces/{id}/subscription` (never shows a Stripe id).
- `POST /internal/stripe/webhook`: signature checked on the raw bytes with Stripe's scheme
  (`t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<body>")`, 300 s tolerance, one or two secrets while rolling);
  bad, stale, tampered or unsigned deliveries are 400 and store nothing; a duplicate is acknowledged
  and stored once. Caddy lets this path through on the API host.
- The worker (`stripe.event.process`, 8 attempts, dead-letter queue, a sweep every minute) re-fetches the
  subscription from Stripe and applies it through B070 and B069. Plan limits are then enforced by the
  entitlement checks described in [entitlements-enforcement.md](entitlements-enforcement.md).

## What a human must do in Stripe

1. Create the account; start in **test mode** (`sk_test_...`) and repeat in live mode.
2. Create twelve prices (products Pro and Team, plus an "extra seat" add-on of Team), recurring monthly
   and yearly, in USD and EUR; paste their ids into `STRIPE_PRICE_{PRO,TEAM,SEAT}_{MONTH,YEAR}_{USD,EUR}`.
   Pro is 1 seat, Team includes 5 seats; the seat price is per extra seat.
3. Developers > Webhooks > add endpoint `https://<your API host>/internal/stripe/webhook`, API version
   `2025-03-31.basil`, events: `customer.subscription.created|updated|deleted|trial_will_end`,
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`. To roll it, put both secrets separated by a comma, then remove the old one.
4. Settings > Billing > Customer portal: enable it (plan changes, cancellation, payment methods) with the
   products above.
5. Optional: Stripe Tax, invoice branding, a restricted key (`rk_live_...`) limited to Customers,
   Checkout Sessions, Billing Portal, Subscriptions, Invoices and Promotion Codes (read).
6. Deploy (`infra/deploy/deploy.sh <tag>`). Try test mode first: Stripe CLI
   `stripe listen --forward-to https://<host>/internal/stripe/webhook`, then buy with card
   `4242 4242 4242 4242`. Watch `stripe_webhooks_total` and `stripe_event_dead_letters_total`.

## Not done yet (honest list)

- **Never run against real Stripe.** Tests use a local stand-in for Stripe's REST API and Stripe's
  documented signature scheme; request shapes follow Stripe's API reference for the pinned version.
- **The billing outbox is not published.** Rows in `billing_outbox` (customer webhooks `billing.*`
  for B081, the `notify.*` notices of B063) are written but nothing sends them yet: the worker's
  publish step is a no-op until the webhook delivery and notification dispatcher workers are started
  in the worker process.
- **Dunning (B078) and trials (B079) are not driven** by the webhook handlers in this process: a
  `past_due` subscription keeps its Stripe status and the contract's `grace_until`, but no reminder
  mail is sent and nothing drops it to `none` by itself; trial-ending mail is not sent.
- Invoices, coupons and seat reconciliation routes (B073-B077) exist as modules but are not
  registered in this process.
