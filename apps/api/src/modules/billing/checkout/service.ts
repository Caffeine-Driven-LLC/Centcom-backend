/**
 * Hosted checkout and billing portal sessions (B071, CT-API-BILLING). Stripe hosts both pages;
 * this service decides what may be bought and where the customer comes back, and nothing else:
 *
 * - **`createCheckout`** sells a paid plan from the server's price catalogue (`pro`, or `team`
 *   with 5 to BILLING_MAX_SEATS seats, the seats above the 5 included as add-on seats) in a
 *   subscription-mode Checkout Session for the workspace's Stripe customer (`ensureCustomer`,
 *   B070: created once, reused on every retry). The return URLs come from configuration
 *   (`redirects.ts`), never from the request. A workspace that already has a subscription in
 *   effect (active, trialing or past due) is refused (409): it changes plans in the portal.
 *   Stripe's idempotency key is derived from the workspace, the caller, the caller's
 *   Idempotency-Key and the request, so a retry of one request (even after a 503, which the
 *   idempotency middleware does not store) gets the same session, and nothing else does.
 * - **`createPortal`** opens the billing portal for the workspace's existing customer; it never
 *   creates one (404 without one). Any status may reach it, past due included.
 * - Nothing here grants an entitlement or stores a subscription: only Stripe's webhooks do
 *   (B072).
 * - The session calls (`#stripe`): Stripe unreachable is 503 with `retry_after_s`. Stripe
 *   refusing the request (a 4xx: a misconfigured price, a revoked key) is a configuration fault:
 *   502 `bad_gateway` with a generic detail, `billing_session_failures_total` and an error log,
 *   never Stripe's message. These cover the session calls only. Finding or creating the
 *   customer is B070's `ensureCustomer`, with B070's answers: a Stripe refusal there is its 500
 *   `internal_error`, an outage its 503, and neither is counted here.
 *
 * Configuration: BILLING_MAX_SEATS (default 500), and WEB_BASE_URL for the return URLs.
 *
 * Owns: what checkout sells and the session calls. Must not: log or keep a session URL or id,
 * accept a price, amount or URL from a client, or change entitlements.
 */
import { createHash } from 'node:crypto';
import {
  AppError,
  conflict,
  defineConfig,
  envInt,
  noopMetrics,
  notFound,
  unavailable,
  z,
  type Actor,
  type Env,
  type Logger,
  type Metrics,
} from '@centcom/core';
import {
  idempotencyKey,
  StripeError,
  type CheckoutInput,
  type StripeGateway,
} from '../stripe/gateway.js';
import {
  INCLUDED_SEATS,
  type Currency,
  type Interval,
  type PaidPlan,
  type PriceCatalog,
} from '../stripe/price-catalog.js';
import type { BillingRepository } from '../subscriptions/repository.js';
import {
  BILLING_DETAILS,
  STRIPE_RETRY_AFTER_S,
  type BillingService,
} from '../subscriptions/service.js';
import { buildRedirects, type RedirectKind } from './redirects.js';

/** The most seats a checkout sells, by default. */
export const DEFAULT_MAX_SEATS = 500;

/** BILLING_MAX_SEATS. */
export const checkoutEnvSchema = z.object({
  BILLING_MAX_SEATS: envInt({ min: INCLUDED_SEATS.team, max: 100_000 })
    .default(DEFAULT_MAX_SEATS)
    .meta({ description: 'The most seats one team checkout may buy.', example: '500' }),
});

/** Checked checkout settings. */
export interface CheckoutConfig {
  maxSeats: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadCheckoutConfig(env?: Env): CheckoutConfig {
  return { maxSeats: defineConfig(checkoutEnvSchema, env).BILLING_MAX_SEATS };
}

/** A checkout request, validated (the route's `parseCheckoutRequest`). */
export interface CheckoutRequestInput {
  plan: PaidPlan;
  interval: Interval;
  currency: Currency;
  /** Total seats; team only (default its 5 included seats). */
  seats?: number;
}

/** A checkout session for the client. */
export interface CheckoutResult {
  url: string;
  /** When Stripe expires the session (ISO 8601), when Stripe said. */
  expiresAt: string | null;
}

/** Statuses of a subscription in effect: checkout is refused, the portal manages it. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/** The details of the service's refusals (GUIDELINES §3.4). */
export const CHECKOUT_DETAILS = Object.freeze({
  alreadySubscribed:
    'This workspace already has a subscription; change it in the billing portal instead.',
  noCustomer: 'This workspace has no billing account yet; start a checkout first.',
  notForSale: 'This plan is not offered in this currency.',
  seatsNotForSale: 'Extra seats are not offered in this currency.',
} as const);

/** The metric names. */
export const CHECKOUT_METRICS = Object.freeze({
  created: 'billing_sessions_created_total',
  failures: 'billing_session_failures_total',
} as const);

/** What the service needs. */
export interface CheckoutServiceDeps {
  gateway: StripeGateway;
  billing: Pick<BillingService, 'ensureCustomer'>;
  repository: Pick<BillingRepository, 'findCustomer' | 'findSubscription'>;
  catalog: PriceCatalog;
  config: CheckoutConfig;
  /** The return URLs; default `buildRedirects` on the configured WEB_BASE_URL. */
  redirects?: (kind: RedirectKind) => string;
  logger?: Logger;
  metrics?: Metrics;
}

/** The caller's id, for the Stripe idempotency key. */
const principalOf = (actor: Actor): string => (actor.kind === 'user' ? actor.userId : actor.keyId);

/** Checkout and portal sessions. */
export class CheckoutService {
  readonly #redirects: (kind: RedirectKind) => string;
  readonly #metrics: Metrics;

  constructor(private readonly deps: CheckoutServiceDeps) {
    this.#redirects = deps.redirects ?? ((kind) => buildRedirects(kind));
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** BILLING_MAX_SEATS: the most seats one team checkout sells. */
  get maxSeats(): number {
    return this.deps.config.maxSeats;
  }

  /**
   * A hosted checkout of `input` for `workspaceId`, asked by `actor` with Idempotency-Key
   * `idemKey`. 409 when the workspace already has a subscription in effect, 422 for a plan or
   * seats the catalogue does not sell, 404 when the workspace has nobody to bill, 503/502 when
   * Stripe is down or refuses the session (B070's 503/500 while it finds or creates the customer).
   */
  async createCheckout(
    workspaceId: string,
    actor: Actor,
    input: CheckoutRequestInput,
    idemKey: string,
  ): Promise<CheckoutResult> {
    const { catalog, repository } = this.deps;
    const current = await repository.findSubscription(workspaceId);
    if (current !== null && ACTIVE_STATUSES.has(current.status)) {
      throw conflict(CHECKOUT_DETAILS.alreadySubscribed);
    }
    const priceId = catalog.price(input.plan, input.interval, input.currency);
    if (priceId === null) throw notForSale('/plan', CHECKOUT_DETAILS.notForSale);
    let seats: CheckoutInput['seats'];
    const addon =
      input.plan === 'team' ? (input.seats ?? INCLUDED_SEATS.team) - INCLUDED_SEATS.team : 0;
    if (addon > 0) {
      const seatPrice = catalog.seatPrice(input.interval, input.currency);
      if (seatPrice === null) throw notForSale('/seats', CHECKOUT_DETAILS.seatsNotForSale);
      seats = { priceId: seatPrice, quantity: addon };
    }
    const { customerId } = await this.deps.billing.ensureCustomer(workspaceId);
    const request = JSON.stringify([
      input.plan,
      input.interval,
      input.currency,
      input.seats ?? null,
    ]);
    const digest = createHash('sha256')
      .update(`${principalOf(actor)}\n${idemKey}\n${request}`)
      .digest('hex')
      .slice(0, 32);
    const session = await this.#stripe('checkout', () =>
      this.deps.gateway.createCheckoutSession(
        {
          customerId,
          workspaceId,
          priceId,
          ...(seats === undefined ? {} : { seats }),
          successUrl: this.#redirects('checkout_success'),
          cancelUrl: this.#redirects('checkout_cancel'),
        },
        idempotencyKey(workspaceId, `checkout-${digest}`),
      ),
    );
    this.#metrics.counter(CHECKOUT_METRICS.created, { kind: 'checkout' }).inc();
    return {
      url: session.url,
      expiresAt:
        session.expiresAt === undefined ? null : new Date(session.expiresAt * 1000).toISOString(),
    };
  }

  /**
   * A billing portal session for `workspaceId`'s existing Stripe customer, returning to the
   * configured billing page. 404 when the workspace has no customer (none is created here).
   */
  async createPortal(workspaceId: string, actor: Actor): Promise<{ url: string }> {
    void actor;
    const customerId = await this.deps.repository.findCustomer(workspaceId);
    if (customerId === null) throw notFound(CHECKOUT_DETAILS.noCustomer);
    const session = await this.#stripe('portal', () =>
      this.deps.gateway.createPortalSession({
        customerId,
        returnUrl: this.#redirects('portal_return'),
      }),
    );
    this.#metrics.counter(CHECKOUT_METRICS.created, { kind: 'portal' }).inc();
    return { url: session.url };
  }

  /** The workspace's plan as stored (`free` without a subscription in effect), for the audit. */
  async currentPlan(workspaceId: string): Promise<'free' | PaidPlan> {
    const row = await this.deps.repository.findSubscription(workspaceId);
    return row !== null && ACTIVE_STATUSES.has(row.status) ? row.plan : 'free';
  }

  /** Runs a Stripe call, turning its failures into the API's errors. */
  async #stripe<T>(kind: 'checkout' | 'portal', call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      const reason = err.kind === 'unavailable' ? 'stripe_unavailable' : 'stripe_refused';
      this.#metrics.counter(CHECKOUT_METRICS.failures, { kind, reason }).inc();
      if (err.kind === 'unavailable') {
        this.deps.logger?.warn({ kind }, 'billing.session_unavailable');
        throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
          cause: new Error(`stripe ${err.kind}`),
        });
      }
      // A configuration fault on the session call (a price Stripe does not know, a revoked key):
      // alert, stay vague.
      this.deps.logger?.error(
        { kind, stripe_kind: err.kind, status: err.status, stripe_code: err.stripeCode },
        'billing.session_failed',
      );
      throw new AppError('bad_gateway', {
        detail: BILLING_DETAILS.stripeRefused,
        cause: new Error(`stripe ${err.kind} ${err.status ?? ''}`.trim()),
      });
    }
  }
}

/** 422 for something the catalogue does not sell, at `pointer`. */
function notForSale(pointer: string, detail: string): AppError {
  return new AppError('validation_failed', {
    detail,
    errors: [{ pointer, code: 'invalid_value', detail: 'is not for sale' }],
  });
}
