# Trials, coupons and promotions (B079)

Coupon redemption (`POST /v1/workspaces/{id}/coupons/redeem`), staff promotion grants (B087),
trial eligibility (for B071) and the trial hooks B072's Stripe event handlers call. The full
description (checks, the transaction, trials, configuration, failure modes, metrics) is
[`docs/billing/trials-and-coupons.md`](../../../../../../docs/billing/trials-and-coupons.md).

## Pieces

| File                | What it does                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `codes.ts`          | `normaliseCode` (NFC, trimmed, upper case) and `codeHash` (sha256): the only form of a code kept. |
| `promotion-code.ts` | `parsePromotionCode` (a Stripe promotion code) and `checkPromotion` (why one cannot apply).       |
| `service.ts`        | `PromotionService`: `countAttempt`, `redeem` and `grantPromotion`.                                |
| `trials.ts`         | `TrialService`: `trialEligibility`, `recordTrial`, `trialWillEnd`.                                |
| `trial-mail.ts`     | The `trial_ending` email template (B032).                                                         |
| `repository.ts`     | `createPromotionRepository`: the ledger row and audit event, trials and their owners (Postgres).  |
| `config.ts`         | `loadPromotionConfig`: TRIAL_DAYS, TRIAL_PLAN, COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR.         |
| `ports.ts`          | `PromotionStripe` (B070's `StripeClient`) and `TrialMail` (B032's email service).                 |
| `index.ts`          | The module's exports.                                                                             |

Route: `routes/billing-coupons.ts` (`couponRoutes`). Tables: `coupon_redemptions`,
`billing_trials` and `billing_trial_owners` (migration `20260102003800_coupon_redemptions.sql`,
types in `@centcom/db`'s `schema/promotions.ts`). B072's handler gained an optional `trials`
dependency (`TrialHooks`) and the `notify.trial_ending` outbox row.

## Wiring

```ts
const config = loadPromotionConfig();
const repository = createPromotionRepository(db);
const promotions = new PromotionService({
  repository,
  billingRepository, // B070's createBillingRepository(db)
  billing, // B070's BillingService
  stripe: stripeConfig === null ? null : stripeClient, // B070's StripeClient
  rateLimit: redis.rateLimit, // B009
  locks: redis.kv, // B009: the per-workspace lock around the Stripe call
  config,
  audit: auditEmitter, // for staff grants' workspace event
  logger,
  metrics,
});
await app.register(couponRoutes, {
  promotions,
  clientIp: (request) => resolveClientIp(request, rateLimitConfig.trustedHops), // B023
});
// After the request-context, error-handler, auth, rate-limit, idempotency, RBAC and audit plugins.

const trials = new TrialService({ repository, billing: billingRepository, config, mail: email });
// B072: new EventProcessor({ ..., trials }); B087: new AdminService({ ..., promotions });
// B071: trials.trialEligibility(workspaceId, userId) before a checkout with a trial.
```
