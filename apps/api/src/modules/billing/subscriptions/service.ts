/**
 * Billing (B070): a workspace's Stripe customer, and its subscription as the API shows it.
 *
 * - **`ensureCustomer`** returns the workspace's customer, creating it once:
 *   1. the stored link, else a customer Stripe already has for the workspace (found by its
 *      `workspace_id` metadata, after a create whose link was lost);
 *   2. else Stripe creates one, with the billing contact's e-mail and locale and an idempotency
 *      key derived from the workspace, so concurrent and retried calls get the same customer;
 *   3. the link is written only after Stripe answered, so a failed call leaves no row.
 *   Concurrent calls in one process share one attempt. Stripe being unreachable is 503 with
 *   `retry_after_s`.
 * - **`getSubscription`** reads the database only, so it keeps working while Stripe is down.
 *   A workspace without an effective subscription (none stored, or status `none`) has none.
 * - **`upsertFromStripe`** stores a Stripe subscription unless a newer event already did (the
 *   stale-event guard). The plan, interval and add-on seats come from the price catalogue. A
 *   currency other than the stored one is stored as returned and logged; an unknown plan price
 *   keeps the stored plan, logged. When applied, the state goes to B069's
 *   `applySubscriptionState`.
 *
 * Owns: these rules. Must not: decide entitlements, store card data or e-mail addresses, or
 * call Stripe on a read.
 */
import { newId, type Api } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  notFound,
  unavailable,
  type Logger,
  type Metrics,
} from '@centcom/core';
import type { SubscriptionState } from '../../entitlements/ports.js';
import { graceUntilFor } from '../../entitlements/resolve.js';
import {
  idempotencyKey,
  StripeError,
  type StripeGateway,
  type StripeSub,
} from '../stripe/gateway.js';
import {
  ADDON_SEAT_PLANS,
  INCLUDED_SEATS,
  type PriceCatalog,
  type PriceEntry,
} from '../stripe/price-catalog.js';
import { mapStripeStatus } from '../stripe/status-map.js';
import type { BillingRepository, SubscriptionRow } from './repository.js';

/** The details of billing's refusals (GUIDELINES §3.4). */
export const BILLING_DETAILS = Object.freeze({
  noSubscription: 'This workspace has no subscription; it is on the free plan.',
  noContact: 'The workspace has no owner or billing member to bill.',
  stripeUnavailable: 'Billing is unavailable right now. Try again shortly.',
  stripeRefused: 'Billing could not complete the request.',
  unknownWorkspace: 'The Stripe subscription belongs to no known workspace.',
  unknownPlan: 'The Stripe subscription sells no plan in the price catalogue.',
} as const);

/** Seconds a client waits after Stripe was unreachable. */
export const STRIPE_RETRY_AFTER_S = 30;

/**
 * A Stripe subscription billing cannot store: it belongs to no known workspace, or sells no plan
 * the catalogue knows (and none was stored before). Retrying will not help; B072 records it.
 */
export class BillingStateError extends Error {
  override name = 'BillingStateError';

  constructor(readonly reason: 'unknown_workspace' | 'unknown_plan') {
    super(
      reason === 'unknown_workspace'
        ? BILLING_DETAILS.unknownWorkspace
        : BILLING_DETAILS.unknownPlan,
    );
  }
}

/** What B069 needs from billing. */
export interface EntitlementsPort {
  applySubscriptionState(workspaceId: string, state: SubscriptionState): Promise<unknown>;
}

/** What the service needs. */
export interface BillingServiceDeps {
  repository: BillingRepository;
  gateway: StripeGateway;
  catalog: PriceCatalog;
  /** B069's entitlements; applied subscriptions are handed to it. */
  entitlements?: EntitlementsPort;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Centcom ids; default `newId`. */
  newId?: (prefix: 'sub') => string;
  logger?: Logger;
  metrics?: Metrics;
}

/** What `upsertFromStripe` did. */
export interface UpsertResult {
  view: Api.Subscription | null;
  /** False when a newer event had already been stored (nothing changed). */
  applied: boolean;
}

/** A Stripe failure on a write path as the API answers it: 503 when it may pass. */
function stripeFailure(err: unknown): never {
  if (err instanceof StripeError) {
    if (err.kind === 'unavailable') {
      throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
        cause: new Error(`stripe ${err.kind}`),
      });
    }
    throw new AppError('internal_error', {
      detail: BILLING_DETAILS.stripeRefused,
      cause: new Error(`stripe ${err.kind} ${err.status ?? ''} ${err.stripeCode ?? ''}`.trim()),
    });
  }
  throw err;
}

const toDate = (seconds: number | null): Date | null =>
  seconds === null ? null : new Date(seconds * 1000);

/** The API's view of a stored subscription; null when it is not effective (`none`). */
export function subscriptionView(row: SubscriptionRow): Api.Subscription | null {
  if (row.status === 'none' || row.periodEnd === null) return null;
  const currency = row.currency === 'USD' || row.currency === 'EUR' ? row.currency : undefined;
  const grace =
    row.status === 'past_due' && row.pastDueSince !== null ? graceUntilFor(row.pastDueSince) : null;
  return {
    id: row.id,
    workspace: row.workspaceId,
    plan: row.plan,
    status: row.status,
    seats: row.seats,
    interval: row.interval,
    ...(currency === undefined ? {} : { currency }),
    ...(row.periodStart === null ? {} : { current_period_start: row.periodStart.toISOString() }),
    current_period_end: row.periodEnd.toISOString(),
    cancel_at_period_end: row.cancelAtPeriodEnd,
    trial_end: row.status === 'trialing' ? row.periodEnd.toISOString() : null,
    grace_until: grace === null ? null : grace.toISOString(),
  };
}

/** Billing's customers and subscriptions. */
export class BillingService {
  readonly #clock: () => number;
  readonly #newId: (prefix: 'sub') => string;
  readonly #metrics: Metrics;
  readonly #inflight = new Map<string, Promise<{ customerId: string }>>();

  constructor(private readonly deps: BillingServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#newId = deps.newId ?? ((prefix) => newId(prefix));
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The workspace's Stripe customer, created once (see the module comment). */
  ensureCustomer(workspaceId: string): Promise<{ customerId: string }> {
    const running = this.#inflight.get(workspaceId);
    if (running !== undefined) return running;
    const attempt = this.#ensureCustomer(workspaceId).finally(() => {
      this.#inflight.delete(workspaceId);
    });
    this.#inflight.set(workspaceId, attempt);
    return attempt;
  }

  async #ensureCustomer(workspaceId: string): Promise<{ customerId: string }> {
    const { repository, gateway } = this.deps;
    const stored = await repository.findCustomer(workspaceId);
    if (stored !== null) return { customerId: stored };
    const contact = await repository.billingContact(workspaceId);
    if (contact === null) throw notFound(BILLING_DETAILS.noContact);
    let customerId: string;
    try {
      const existing = await gateway.findCustomerByWorkspace(workspaceId);
      if (existing !== null) {
        customerId = existing.id;
        this.deps.logger?.info({ workspace_id: workspaceId }, 'billing.customer_relinked');
      } else {
        const created = await gateway.createCustomer(
          {
            workspaceId,
            email: contact.email,
            name: contact.name,
            locale: contact.locale,
          },
          idempotencyKey(workspaceId, 'customer-create'),
        );
        customerId = created.id;
        this.#metrics.counter('billing_customers_created_total').inc();
      }
    } catch (err) {
      return stripeFailure(err);
    }
    const linked = await repository.linkCustomer(workspaceId, customerId);
    if (linked !== customerId) {
      this.deps.logger?.warn({ workspace_id: workspaceId }, 'billing.customer_link_lost_race');
    }
    return { customerId: linked };
  }

  /** The workspace's subscription from the database, or null when it has none in effect. */
  async getSubscription(workspaceId: string): Promise<Api.Subscription | null> {
    const row = await this.deps.repository.findSubscription(workspaceId);
    return row === null ? null : subscriptionView(row);
  }

  /** The workspace's subscription, or a 404 when it has none in effect. */
  async requireSubscription(workspaceId: string): Promise<Api.Subscription> {
    const view = await this.getSubscription(workspaceId);
    if (view === null) throw notFound(BILLING_DETAILS.noSubscription);
    return view;
  }

  /**
   * Stores `sub`, written by a Stripe event created at `eventCreated` (Unix seconds), unless a
   * newer event already did; hands applied states to B069.
   */
  async upsertFromStripe(sub: StripeSub, eventCreated: number): Promise<UpsertResult> {
    const { repository, catalog, logger } = this.deps;
    const workspaceId =
      (await repository.workspaceOfCustomer(sub.customerId)) ?? sub.workspaceId ?? null;
    if (workspaceId === null || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId)) {
      throw new BillingStateError('unknown_workspace');
    }
    const stored = await repository.findSubscription(workspaceId);

    let plan: (PriceEntry & { kind: 'plan' }) | null = null;
    let addonSeats = 0;
    for (const item of sub.items) {
      const entry = catalog.lookup(item.priceId);
      if (entry?.kind === 'plan' && plan === null) plan = entry;
      else if (entry?.kind === 'seat') addonSeats += item.quantity;
    }
    if (plan === null) {
      if (stored === null) {
        throw new BillingStateError('unknown_plan');
      }
      logger?.warn({ workspace_id: workspaceId }, 'billing.unknown_plan_price');
    }
    const planId = plan?.plan ?? stored?.plan ?? 'pro';
    if (!ADDON_SEAT_PLANS.has(planId)) addonSeats = 0;
    const currency = sub.currency;
    if (stored !== null && stored.currency !== currency) {
      logger?.warn(
        { workspace_id: workspaceId, stored: stored.currency, returned: currency },
        'billing.currency_changed',
      );
    }
    const status = mapStripeStatus(sub.status, logger);
    const now = new Date(this.#clock());
    const row: SubscriptionRow = {
      workspaceId,
      id: stored?.id ?? this.#newId('sub'),
      stripeSubscriptionId: sub.id,
      plan: planId,
      status,
      interval: plan?.interval ?? stored?.interval ?? 'month',
      currency,
      periodStart: toDate(sub.periodStart),
      periodEnd: toDate(sub.periodEnd),
      seats: INCLUDED_SEATS[planId] + addonSeats,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      pastDueSince:
        status === 'past_due'
          ? ((stored?.status === 'past_due' ? stored.pastDueSince : null) ?? now)
          : null,
      updatedAt: now,
      stripeEventCreated: eventCreated,
    };
    const result = await repository.upsertSubscription(row);
    this.#metrics
      .counter('billing_subscription_updates_total', { applied: String(result.applied) })
      .inc();
    if (!result.applied) {
      logger?.info(
        { workspace_id: workspaceId, event_created: eventCreated },
        'billing.stale_update_ignored',
      );
      return { view: subscriptionView(result.row), applied: false };
    }
    await this.deps.entitlements?.applySubscriptionState(workspaceId, {
      plan: result.row.plan,
      status: result.row.status,
      period:
        result.row.periodStart === null || result.row.periodEnd === null
          ? null
          : { start: result.row.periodStart, end: result.row.periodEnd },
      past_due_since: result.row.pastDueSince,
      addon_seats: Math.max(0, result.row.seats - INCLUDED_SEATS[result.row.plan]),
    });
    return { view: subscriptionView(result.row), applied: true };
  }
}
