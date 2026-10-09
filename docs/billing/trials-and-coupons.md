# Trials, coupons and promotions (B079)

Free trials and coupon codes for Centcom's paid plans, backed by Stripe promotion codes
([CT-API-BILLING](../../contracts/02-rest-api.md) `redeemCoupon`). Stripe keeps the coupons, the
promotion codes and their redemption counts; Centcom keeps a ledger of what it applied (code
hashes, never codes) and the trials Stripe confirmed.

Code: `apps/api/src/modules/billing/promotions/` (see its README) and
`apps/api/src/routes/billing-coupons.ts`. Tables: migration
`packages/db/migrations/20260102003800_coupon_redemptions.sql`.

## Redeeming a coupon

`POST /v1/workspaces/{id}/coupons/redeem` with `{"code": "…"}`.

- **Who:** scope `billing:write`; the workspace's owner and billing members (B021 RBAC
  `billing.manage`, CT-RBAC "Change plan, payment method, seats"). Admins, members and guests get
  403 `forbidden`; anyone else, and an unknown or malformed id, 404. An API key needs
  `billing:write` and its own workspace.
- **Idempotency** (CT-PAGE, B024): `Idempotency-Key` accepted. The same key and body replay the
  stored answer with `Idempotency-Replayed: true`; the same key with another body is 409
  `idempotency_conflict`. A 5xx is not stored, so a retry with the same key runs again.
- **Rate:** 10 attempts per workspace per hour, valid or not, and 10 per client address per hour
  (B023's normalised address bucket), then 429 `rate_limited` with `Retry-After`. The attempt is
  counted in the route's `preValidation`, after the caller is authorised (refused callers count
  for no one) and before B024 claims the Idempotency-Key, so a 429 is never stored and replayed:
  a retry after `Retry-After` runs. A replay is an attempt too. If the counter cannot be reached,
  the endpoint answers 503 rather than lifting the limit.
- **Answer:** 200 with the workspace's `Subscription` after the coupon (the contract's shape; it
  has no discount field, the discount shows on Stripe's invoices).

### What is checked

The code is normalised (Unicode NFC, trimmed, upper case: Stripe's codes are case-insensitive)
and looked up among Stripe's active promotion codes (the one restricted to this customer, else the
general one). Every well-formed code costs the same two Stripe calls (the lookup and the
subscription's discounts, together), so neither the answer nor its timing tells whether a code
exists. It is applied only when:

1. the workspace has a subscription in effect (active, trialing or past due); otherwise 403
   `subscription_inactive`, before Stripe is asked anything;
2. the promotion code and its coupon are active and valid;
3. neither has expired (`expires_at`, the coupon's `redeem_by`);
4. neither is exhausted (`max_redemptions` against `times_redeemed`);
5. it is not restricted to another Stripe customer;
6. a first-time-only code (`restrictions.first_time_transaction`) is used while the subscription
   is still in its trial (it has not been billed);
7. a coupon limited to some products (`applies_to`) covers one of the subscription's products;
8. an amount-off coupon is in the subscription's currency (or has an amount for it in
   `currency_options`);
9. the workspace has not redeemed this promotion before (a retry of the request that did, with
   its Idempotency-Key, answers 200 as it did).

**Every refusal is the same answer:** 422 `coupon_invalid` (problem+json, CT-ERR) with
`errors[0].pointer` `/code` and one detail text, whatever the reason, including a code that does
not exist, one Stripe refuses, or one that is not even shaped like a code. Nothing tells a caller
whether a code exists. The reason is counted (`coupon_refusals_total{reason}`) and logged at info,
without the code. A body that is not `CouponRedeem` (no `code`, not a string, over 64 characters)
is 422 `validation_failed`.

### Applying

No database transaction is open while Stripe is called (a Stripe call can take tens of seconds;
a transaction left idle that long is cut by Postgres):

1. **The ledger is read first.** A row for this workspace and promotion written by this request
   (the same Idempotency-Key, `request_fingerprint`) answers 200 as before; any other is the
   generic 422.
2. **Stripe, under a per-workspace lock** (B009's `setIfAbsent`, 60 s, waited for up to 10 s, then
   503): the subscription's discounts are read again; if the promotion is already on it (an earlier
   try whose answer was lost), it is not applied again; else the promotion code is added to the
   subscription's discounts, the others kept, with the idempotency key
   `centcom-<workspace>-promo-<promo id>`. The lock keeps two promotions applied at once from
   replacing each other's discount (Stripe replaces the list it is given).
3. **The ledger row and the audit event** `billing.coupon` (meta: the plan, CT-API-AUDIT's name) in
   one short transaction, unique on `(workspace_id, stripe_promotion_id)`: if another request
   recorded it first, this one is the generic 422 (Stripe applied it once for both).
4. **The answer:** the subscription Stripe returned, stored through B070's `upsertFromStripe`
   (stamped with the last stored event's time, so every later Stripe event still wins), which
   hands it to B069: entitlements' `rev` moves only when the entitlements changed, and a discount
   changes none.

Unreachable Stripe is 503 with `retry_after_s`, and safe to retry with the same key: if Stripe did
apply the promotion, step 2 finds it and the retry records it. A refusal by Stripe (for example, a
single-use code another workspace redeemed a moment earlier) is the generic 422.

### Staff grants (B087)

`PromotionService.grantPromotion(workspaceId, promotionCodeId, actor)` applies a promotion by its
`promo_…` id for B087's admin API (it satisfies B087's `PromotionGranter`). The checks, lock, ledger
and idempotency are the same; there is no rate limit and no user on the row; refusals point at
`/promotion_code_id`. When the service has an audit emitter, the workspace's `billing.coupon` event
is written with the staff actor (B087 audits the staff call itself either way).

## Trials

- **Eligibility** (`TrialService.trialEligibility(workspaceId, userId)`, for B071's checkout): one
  trial per workspace and per owner. The answer is `{eligible, reason?, days, plan}` with
  `days` = TRIAL_DAYS and `plan` = TRIAL_PLAN.

  | The workspace                                             | Answer                    |
  | --------------------------------------------------------- | ------------------------- |
  | pays (active or past due)                                 | refused, `workspace_paid` |
  | is in a trial, or had one                                 | refused, `already_used`   |
  | the asking user or one of its owners had a trial anywhere | refused, `already_used`   |
  | paid before (canceled), no trial                          | refused, `workspace_paid` |
  | none of these                                             | eligible                  |

- **Recording:** a trial is recorded only once Stripe confirms it: whenever B072 reconciles a
  subscription Stripe reports `trialing` (`recordTrial`), with every owner the workspace has then
  (`billing_trial_owners`). Nothing else grants or records a trial. The record (`billing_trials`)
  outlives the workspace (its `workspace_id` is set null on purge) so a deleted and recreated
  workspace does not get a second trial; deleting an owner's account removes their owner row.
- **Trial ending:** Stripe sends `customer.subscription.trial_will_end` three days before a trial
  ends. B072's handler reconciles the subscription and writes two outbox rows: one
  `billing.subscription.updated` for the event (B081 delivers it to the workspace's webhook
  endpoints) and one `notify.trial_ending` per subscription and trial end, which B063's dispatcher
  turns into CT-NOTIF's `trial_ending {days}` notification for the owners and billing members (inbox
  by default; CT-API-NOTIFY gives it no switches). It then calls `trialWillEnd`, which emails the
  billing contact (the earliest billing member, else the owner) through B032 with the
  `trial_ending` template, as the card asks: a transactional billing email (like Stripe's
  receipts) with the workspace's name and the trial's end, not a CT-NOTIF channel. The email's
  idempotency key is the subscription and the trial end, so a redelivered event sends one email.
  An email failure is thrown, and B072 retries the event.
- **When a trial ends without a payment method,** Stripe moves the subscription; B072 and B078
  handle the resulting status. This lane does nothing special.

Stripe's webhook endpoint must send `customer.subscription.trial_will_end` (it is now one of
B072's handled types).

## Configuration

| Key                                         | Default | Rule        | What                                                      |
| ------------------------------------------- | ------- | ----------- | --------------------------------------------------------- |
| `TRIAL_DAYS`                                | 14      | 1 to 90     | How long a trial lasts.                                   |
| `TRIAL_PLAN`                                | `team`  | pro or team | The paid plan a trial is of (B069's default plans).       |
| `COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR` | 10      | 1 to 1 000  | Redeem attempts per workspace, and per address, per hour. |

The keys are read by `loadPromotionConfig()`; a bad value is a ConfigError naming the key. Stripe
keys are B070's.

## Failure modes

| What                                             | What happens                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Stripe unreachable (lookup, read or apply)       | 503 `service_unavailable`, `retry_after_s` 30; no ledger row; retry with the key.      |
| Stripe applied it, but its answer was lost       | 503; the retry finds the promotion on the subscription, records it, 200.               |
| Stripe refuses the application                   | The generic 422; no ledger row.                                                        |
| Two workspaces race for a single-use code        | Stripe accepts one; the other gets the generic 422.                                    |
| One workspace redeems one code twice at once     | One 200; the other finds it applied or recorded: the generic 422; Stripe applies once. |
| One workspace redeems two codes at once          | The lock takes them one after the other; both discounts stay.                          |
| The lock stays taken for 10 s                    | 503 with `retry_after_s` 1.                                                            |
| The answer is lost after the row was written     | A retry with the same key answers 200 from the ledger (B024 keeps no 5xx).             |
| Stripe answers something that is not a promotion | 500, logged as an error.                                                               |
| The rate-limit store is down                     | 503 (the limit is not lifted).                                                         |
| Billing is off (no Stripe key)                   | 503 (403 `subscription_inactive` first: there is no subscription).                     |
| The trial-ending email fails                     | The Stripe event is retried by B072 (the email's key keeps it to one).                 |

## Metrics

| Metric                               | What                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `coupon_redemptions_total{outcome}`  | redeemed, replayed, refused, malformed, inactive, rate_limited, stripe_unavailable, busy.                                 |
| `coupon_refusals_total{reason}`      | unknown, malformed, inactive, expired, exhausted, customer, first_time, plan, currency, already_redeemed, stripe_refused. |
| `trials_recorded_total`              | Trials recorded once Stripe confirmed them.                                                                               |
| `trial_ending_emails_total{outcome}` | sent, not_trialing, not_configured, no_contact.                                                                           |

## Privacy and retention

- The code is never stored, logged, audited or put in a metric: the ledger keeps its sha256 (of the
  normalised code). `request_fingerprint` is the sha256 of the Idempotency-Key (else of the request
  id).
- `coupon_redemptions` rows go with their workspace (B027's purge cascades); `user_id` is set null
  when the account is deleted.
- `billing_trials` and `billing_trial_owners` rows are kept 24 months after the trial ended, or
  after it was recorded when Stripe gave no end (B090 to enforce), outliving the workspace
  (`workspace_id` set null) so one trial per workspace and owner holds; an owner row goes with the
  owner's account.
- The trial email holds the workspace's name and a date; nothing about prices, cards or the
  account.

## How to test

`apps/api/test/billing/promotions/`:

- `promotions.codes`: normalisation and hashing, the configuration, the eligibility truth table,
  `recordTrial`;
- `promotions.redeem`: the happy path, replay and conflict, once per workspace, privacy;
- `promotions.invalid`: every refusal the same, `validation_failed`, `subscription_inactive`, races;
- `promotions.authz`: the five roles, other workspaces, scopes and API keys;
- `promotions.ratelimit`: the 11th attempt, per workspace and per address, replays;
- `promotions.failure`: Stripe timeouts (503, no row, retry), lost answers, billing off, the
  limiter down;
- `promotions.contract`: problem+json per CT-ERR with listed codes, the CT-PAGE headers and keys;
- `promotions.trials`: `trial_will_end` and trial recording through B072's `handleEvent`, the template;
- `promotions.grant`: staff grants and B087's port;
- `promotions.stripe-client`: the four Stripe calls over HTTP;
- `promotions.repository`: the statements on a scripted driver;
- `promotions.postgres` (`DATABASE_URL`): the short transaction, the unique key under 10
  concurrent records, the trial history and owners across purges.
