/**
 * Coupons and promotions (B079): `POST /v1/workspaces/{id}/coupons/redeem` and B087's
 * `grantPromotion`, backed by Stripe promotion codes.
 *
 * - **Rate** (`countAttempt`, called by the route before B024 claims the Idempotency-Key, so a
 *   429 is never stored and replayed): COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR attempts
 *   (default 10) per workspace and per client address (B023's normalised `ipBucket`) per hour,
 *   valid or not; past either, 429 with `Retry-After`. If the counter cannot be reached, 503: the
 *   limit is never lifted.
 * - **The body** must be CT-API-BILLING's `CouponRedeem` (422 `validation_failed` otherwise).
 *   **The code** is normalised (NFC, trimmed, upper case) and hashed (sha256); the code itself is
 *   never stored, logged or audited.
 * - **The subscription:** the workspace's, in effect (active, trialing or past due); otherwise
 *   403 `subscription_inactive` (the answer is a `Subscription`, so there is nothing else to
 *   apply a coupon to).
 * - **Every well-formed code costs the same Stripe calls** (the lookup and the subscription's
 *   discounts, together), so neither the answer nor its timing tells whether a code exists.
 * - **Checks** (`checkPromotion`): Stripe has an active promotion code with that text (the one
 *   for this customer, else the general one), not expired, not exhausted, not restricted to
 *   another customer, not first-time only (unless the subscription is still in its trial), for
 *   the subscription's products and its currency.
 * - **Every refusal is the same** 422 `coupon_invalid` at `/code` with one detail text, whatever
 *   the reason (unknown, expired, exhausted, already redeemed by this workspace, refused by
 *   Stripe): the reason goes to a metric and an info log only.
 * - **Applying**, never inside a database transaction:
 *   1. a ledger row for this workspace and promotion: the request that wrote it (same
 *      Idempotency-Key) answers as it did; any other is refused;
 *   2. under a per-workspace lock (B009, so two promotions applied at once do not replace each
 *      other's discount), the subscription's discounts are read again; if the promotion is
 *      already on it (an earlier try whose answer was lost), it is not applied again; else
 *      Stripe adds it, keeping the others, with the idempotency key `promo-<promo>` of the
 *      workspace;
 *   3. the ledger row (`UNIQUE(workspace_id, stripe_promotion_id)`) and the audit event
 *      `billing.coupon` (CT-API-AUDIT's name) in one short transaction;
 *   4. the subscription Stripe returned, stored through B070's `upsertFromStripe` (stamped with
 *      the last stored event's time, so every later Stripe event still wins), which hands it to
 *      B069: entitlements' `rev` moves only if they changed (a discount changes none).
 *   Stripe unreachable is 503 with `retry_after_s` (safe to retry with the same key: step 2 finds
 *   a promotion Stripe did apply); a Stripe refusal (two workspaces racing for a single-use code)
 *   is the generic 422.
 * - `grantPromotion` applies a promotion by id for B087's staff, with the same checks, lock and
 *   ledger (no rate limit, no user; B087 audits the staff call, and the workspace's
 *   `billing.coupon` event is written with the staff actor when an audit emitter is given).
 *
 * Owns: redeeming and granting. Must not: keep, log or audit a code; tell which check failed;
 * apply a promotion twice; or hold a database transaction open across a Stripe call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { newId, validate, type Api } from '@centcom/contracts';
import {
  AppError,
  ipBucket,
  noopMetrics,
  normalizeIp,
  RATE_LIMITED_DETAIL,
  tooManyRequests,
  unavailable,
  validationFailed,
  type Actor,
  type AuditDb,
  type AuditEmitter,
  type KeyValue,
  type Logger,
  type Metrics,
  type RateLimitStore,
} from '@centcom/core';
import type { AuditInput } from '../../../plugins/audit.js';
import { idempotencyKey, StripeError, type StripeSub } from '../stripe/gateway.js';
import type { BillingRepository, SubscriptionRow } from '../subscriptions/repository.js';
import {
  BILLING_DETAILS,
  STRIPE_RETRY_AFTER_S,
  type BillingService,
} from '../subscriptions/service.js';
import { codeHash, normaliseCode } from './codes.js';
import { REDEEM_WINDOW_S, type PromotionConfig } from './config.js';
import type { PromotionStripe, SubscriptionDiscounts } from './ports.js';
import {
  checkPromotion,
  parsePromotionCode,
  type PromotionCode,
  type PromotionRefusal,
} from './promotion-code.js';
import type { PromotionRepository, StoredRedemption } from './repository.js';

/** The user-facing details (GUIDELINES §3.4: one message table). */
export const PROMOTION_DETAILS = Object.freeze({
  invalid: 'This code cannot be redeemed for this workspace.',
  noSubscription: 'This workspace has no subscription a coupon can apply to.',
  body: 'The request body must be {"code": "<1 to 64 characters>"}.',
  busy: 'Another billing change of this workspace is in progress. Try again shortly.',
} as const);

/** Why a redemption was refused, as a metric label (never shown). */
export type RefusalReason =
  PromotionRefusal | 'malformed' | 'unknown' | 'already_redeemed' | 'stripe_refused';

/** Subscription statuses a coupon can apply to. */
const IN_EFFECT: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/** How long the per-workspace lock lives (above the Stripe client's worst case, about 43 s). */
export const PROMOTION_LOCK_TTL_MS = 60_000;
/** How long a redemption waits for the lock before answering 503. */
export const PROMOTION_LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;

/** The subscription a promotion applies to, and its customer. */
interface Target {
  row: SubscriptionRow;
  customerId: string;
}

/** What the ledger row records besides the promotion. */
interface LedgerInput {
  userId: string | null;
  codeHash: string;
  requestFingerprint: string | null;
}

/** A staff member (B087's `StaffActor`). */
export interface StaffActor {
  type: 'staff';
  id: string;
}

/** A redemption request. */
export interface RedeemInput {
  workspaceId: string;
  actor: Actor;
  /** The request body, unchecked. */
  body: unknown;
  /** The request's Idempotency-Key, if any. */
  idempotencyKey?: string | undefined;
  /** The request id (CT-IDS `req_`), for the ledger's fingerprint when there is no key. */
  requestId: string;
  /** `request.audit`: writes the audit event in the ledger row's transaction. */
  audit(trx: AuditDb, input: AuditInput): Promise<unknown>;
}

/** What the service needs. */
export interface PromotionServiceDeps {
  repository: PromotionRepository;
  /** B070's repository: the subscription and the customer. */
  billingRepository: Pick<BillingRepository, 'findSubscription' | 'findCustomer'>;
  /** B070's service: stores what Stripe returned and hands it to B069. */
  billing: Pick<BillingService, 'upsertFromStripe' | 'requireSubscription'>;
  /** Null when billing is off (no Stripe key). */
  stripe: PromotionStripe | null;
  /** B009's rate-limit store (Redis). */
  rateLimit: RateLimitStore;
  /** B009's key-value store (Redis), for the per-workspace lock. */
  locks: Pick<KeyValue, 'setIfAbsent' | 'get' | 'del'>;
  config: Pick<PromotionConfig, 'redeemRatePerHour'>;
  /** For `grantPromotion`'s workspace audit event (staff actor); optional. */
  audit?: Pick<AuditEmitter, 'emit'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Waits between lock attempts; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  metrics?: Metrics;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The generic refusal: the same status, code, pointer and detail for every reason. */
const couponInvalid = (pointer = '/code'): AppError =>
  new AppError('coupon_invalid', {
    detail: PROMOTION_DETAILS.invalid,
    errors: [{ pointer, code: 'coupon_invalid' }],
  });

/** A refusal with its reason, for the metric and the log (the reason never reaches the client). */
class Refused extends Error {
  override name = 'Refused';
  constructor(readonly reason: RefusalReason) {
    super(reason);
  }
}

/** Whether `existing` was written by the request with this fingerprint. */
const sameRequest = (existing: StoredRedemption, fingerprint: string | null): boolean =>
  fingerprint !== null && existing.requestFingerprint === fingerprint;

/** Coupons and promotions. */
export class PromotionService {
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #metrics: Metrics;

  constructor(private readonly deps: PromotionServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Counts an outcome. */
  #count(outcome: string): void {
    this.#metrics.counter('coupon_redemptions_total', { outcome }).inc();
  }

  /**
   * Counts a redeem attempt for the workspace and the client address `ip`; a 429 past either
   * limit, a 503 when the counter cannot be reached.
   */
  async countAttempt(workspaceId: string, ip: string): Promise<void> {
    const limit = this.deps.config.redeemRatePerHour;
    let blocked: number | null = null;
    try {
      const keys = [`coupon-wsp-${workspaceId}`, `coupon-ip-${ipBucket(normalizeIp(ip) ?? ip)}`];
      for (const key of keys) {
        const result = await this.deps.rateLimit.consume(key, limit, REDEEM_WINDOW_S);
        if (!result.allowed) blocked = Math.max(blocked ?? 0, result.resetS);
      }
    } catch (err) {
      // Fail closed: without the counter there is no brute-force protection.
      throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
        cause: err instanceof Error ? err : new Error('rate limit store'),
      });
    }
    if (blocked !== null) {
      this.#count('rate_limited');
      throw tooManyRequests(blocked, RATE_LIMITED_DETAIL);
    }
  }

  /** The workspace's subscription in effect and its customer; 403 `subscription_inactive` else. */
  async #target(workspaceId: string): Promise<Target> {
    const row = await this.deps.billingRepository.findSubscription(workspaceId);
    const customerId = await this.deps.billingRepository.findCustomer(workspaceId);
    if (row === null || !IN_EFFECT.has(row.status) || customerId === null) {
      this.#count('inactive');
      throw new AppError('subscription_inactive', { detail: PROMOTION_DETAILS.noSubscription });
    }
    return { row, customerId };
  }

  /** Turns a Stripe failure into the API's: 503 when unreachable, the refusal when refused. */
  #stripeFailure(err: unknown, step: string): never {
    if (err instanceof StripeError) {
      if (err.kind === 'unavailable') {
        this.#count('stripe_unavailable');
        this.deps.logger?.warn({ step }, 'billing.coupon_stripe_unavailable');
        throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
          cause: new Error(`stripe ${err.kind}`),
        });
      }
      if (err.kind === 'request') {
        this.deps.logger?.info(
          { step, status: err.status, stripe_code: err.stripeCode },
          'billing.coupon_stripe_refused',
        );
        throw new Refused('stripe_refused');
      }
      this.deps.logger?.error(
        { step, stripe_kind: err.kind, status: err.status, stripe_code: err.stripeCode },
        'billing.coupon_stripe_failed',
      );
      throw new AppError('internal_error', {
        detail: BILLING_DETAILS.stripeRefused,
        cause: new Error(`stripe ${err.kind} ${err.status ?? ''}`.trim()),
      });
    }
    throw err;
  }

  /** Runs `call` against Stripe, turning its failures into the API's. */
  async #stripe<T>(step: string, call: (stripe: PromotionStripe) => Promise<T>): Promise<T> {
    const { stripe } = this.deps;
    if (stripe === null) {
      throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
        cause: new Error('billing is off'),
      });
    }
    try {
      return await call(stripe);
    } catch (err) {
      return this.#stripeFailure(err, step);
    }
  }

  /** A Stripe promotion code as the checks read it; a 500 when Stripe sent something else. */
  #parse(raw: unknown): PromotionCode {
    try {
      return parsePromotionCode(raw);
    } catch (err) {
      return this.#stripeFailure(err, 'parse');
    }
  }

  /** Runs `fn` holding the workspace's lock (B009); 503 when it stays taken. */
  async #locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const key = `coupon-lock-${workspaceId}`;
    const token = randomUUID();
    const deadline = this.#clock() + PROMOTION_LOCK_WAIT_MS;
    while (!(await this.deps.locks.setIfAbsent(key, token, PROMOTION_LOCK_TTL_MS))) {
      if (this.#clock() >= deadline) {
        this.#count('busy');
        throw unavailable(1, PROMOTION_DETAILS.busy);
      }
      await this.#sleep(LOCK_POLL_MS);
    }
    try {
      return await fn();
    } finally {
      if ((await this.deps.locks.get(key).catch(() => null)) === token) {
        await this.deps.locks.del(key).catch(() => 0);
      }
    }
  }

  /** The workspace's subscription after `sub` (null: as stored), through B070 and B069. */
  async #answer(workspaceId: string, target: Target, sub: StripeSub | null) {
    if (sub === null) return this.deps.billing.requireSubscription(workspaceId);
    const stored = await this.deps.billing.upsertFromStripe(sub, target.row.stripeEventCreated);
    return stored.view ?? (await this.deps.billing.requireSubscription(workspaceId));
  }

  /** Checks, applies and records `promo` for the workspace (see the module comment). */
  async #apply(
    workspaceId: string,
    target: Target,
    promo: PromotionCode,
    discounts: SubscriptionDiscounts,
    ledger: LedgerInput,
    audit: ((trx: AuditDb) => Promise<unknown>) | undefined,
  ): Promise<Api.Subscription> {
    const existing = await this.deps.repository.findRedemption(workspaceId, promo.id);
    if (existing !== null) {
      if (!sameRequest(existing, ledger.requestFingerprint)) throw new Refused('already_redeemed');
      this.#count('replayed');
      return this.#answer(workspaceId, target, null);
    }
    const subscriptionId = target.row.stripeSubscriptionId;
    const applied = (d: SubscriptionDiscounts) =>
      d.discounts.some((discount) => discount.promotionCodeId === promo.id);
    if (!applied(discounts)) {
      const refusal = checkPromotion(promo, {
        now: Math.floor(this.#clock() / 1000),
        customerId: target.customerId,
        status: target.row.status,
        currency: target.row.currency,
        productIds: discounts.productIds,
      });
      if (refusal !== null) throw new Refused(refusal);
    }
    const sub = await this.#locked(workspaceId, async () => {
      const fresh = await this.#stripe('discounts', (s) => s.subscriptionDiscounts(subscriptionId));
      // Already on the subscription (a try whose answer was lost): record it, apply nothing.
      if (applied(fresh)) {
        return this.#stripe('retrieve', (s) => s.retrieveSubscription(subscriptionId));
      }
      return this.#stripe('apply', (s) =>
        s.applyPromotionCode(
          {
            subscriptionId,
            promotionCodeId: promo.id,
            keepDiscountIds: fresh.discounts.map((d) => d.id),
          },
          idempotencyKey(workspaceId, `promo-${promo.id}`),
        ),
      );
    });
    const outcome = await this.deps.repository.record(
      {
        id: newId('req').slice('req_'.length),
        workspaceId,
        userId: ledger.userId,
        codeHash: ledger.codeHash,
        stripePromotionId: promo.id,
        requestFingerprint: ledger.requestFingerprint,
      },
      audit,
    );
    if (!outcome.recorded && !sameRequest(outcome.existing, ledger.requestFingerprint)) {
      // Another request recorded it first (Stripe applied it once for both).
      throw new Refused('already_redeemed');
    }
    const view = await this.#answer(workspaceId, target, sub);
    this.#count('redeemed');
    this.deps.logger?.info(
      { workspace_id: workspaceId, promotion: promo.id },
      'billing.coupon_redeemed',
    );
    return view;
  }

  /** Answers a refusal the one generic way, after counting and logging its reason. */
  #refuse(err: unknown, workspaceId: string, pointer?: string): never {
    if (!(err instanceof Refused)) throw err;
    this.#count('refused');
    this.#metrics.counter('coupon_refusals_total', { reason: err.reason }).inc();
    this.deps.logger?.info(
      { workspace_id: workspaceId, reason: err.reason },
      'billing.coupon_refused',
    );
    throw couponInvalid(pointer);
  }

  /** Of the promotion codes Stripe found, the one for this customer, else the general one. */
  #choose(found: unknown[], customerId: string): PromotionCode {
    const codes = found.map((raw) => this.#parse(raw));
    const promo =
      codes.find((c) => c.customerId === customerId) ??
      codes.find((c) => c.customerId === null) ??
      codes[0];
    if (promo === undefined) throw new Refused('unknown');
    return promo;
  }

  /**
   * `POST /v1/workspaces/{id}/coupons/redeem` (see the module comment); the route has counted the
   * attempt (`countAttempt`).
   */
  async redeem(input: RedeemInput): Promise<Api.Subscription> {
    const { workspaceId } = input;
    const checked = validate('api/CouponRedeem', input.body);
    if (!checked.ok) {
      this.#count('malformed');
      throw validationFailed(checked.errors, PROMOTION_DETAILS.body);
    }
    const code = normaliseCode(checked.value.code);
    try {
      if (code === null) throw new Refused('malformed');
      const target = await this.#target(workspaceId);
      const [found, discounts] = await Promise.all([
        this.#stripe('find', (s) => s.findPromotionCodes(code)),
        this.#stripe('discounts', (s) => s.subscriptionDiscounts(target.row.stripeSubscriptionId)),
      ]);
      const promo = this.#choose(found, target.customerId);
      const userId = input.actor.kind === 'user' ? input.actor.userId : null;
      return await this.#apply(
        workspaceId,
        target,
        promo,
        discounts,
        {
          userId,
          codeHash: codeHash(code),
          requestFingerprint: sha256(input.idempotencyKey ?? input.requestId),
        },
        (trx) =>
          input.audit(trx, {
            action: 'billing.coupon',
            target: { type: 'workspace', id: workspaceId },
            meta: { plan: target.row.plan },
          }),
      );
    } catch (err) {
      return this.#refuse(err, workspaceId);
    }
  }

  /**
   * Applies promotion `promotionCodeId` (`promo_…`) to the workspace's subscription for B087's
   * staff (`StaffActor`) or another internal caller: the same checks, lock and ledger as a
   * redemption, no rate limit. Answers the subscription after it.
   */
  async grantPromotion(
    workspaceId: string,
    promotionCodeId: string,
    actor: Actor | StaffActor,
  ): Promise<Api.Subscription> {
    try {
      if (!/^promo_[A-Za-z0-9]{1,250}$/.test(promotionCodeId)) throw new Refused('malformed');
      const target = await this.#target(workspaceId);
      const [raw, discounts] = await Promise.all([
        this.#stripe('retrieve', (s) => s.retrievePromotionCode(promotionCodeId)),
        this.#stripe('discounts', (s) => s.subscriptionDiscounts(target.row.stripeSubscriptionId)),
      ]);
      const promo = this.#parse(raw);
      if (promo.codeHash === null) throw new Refused('unknown');
      const userId = 'kind' in actor && actor.kind === 'user' ? actor.userId : null;
      const emitter = this.deps.audit;
      const auditActor =
        'type' in actor
          ? { type: 'staff' as const, id: actor.id }
          : actor.kind === 'user'
            ? { type: 'user' as const, id: actor.userId }
            : { type: 'api_key' as const, id: actor.keyId };
      return await this.#apply(
        workspaceId,
        target,
        promo,
        discounts,
        { userId, codeHash: promo.codeHash, requestFingerprint: null },
        emitter === undefined
          ? undefined
          : (trx) =>
              emitter.emit(trx, {
                workspaceId,
                actor: auditActor,
                action: 'billing.coupon',
                target: { type: 'workspace', id: workspaceId },
                outcome: 'success',
                meta: { plan: target.row.plan },
              }),
      );
    } catch (err) {
      return this.#refuse(err, workspaceId, '/promotion_code_id');
    }
  }
}
