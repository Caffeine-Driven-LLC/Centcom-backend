/**
 * Seat quantity for Team workspaces (B073): `PATCH /v1/workspaces/{id}/seats`, its preview, and
 * the reconciliation of stored seats with Stripe.
 *
 * - **Seats** are the total: Team's 5 included seats plus the add-on seat item's quantity on the
 *   Stripe subscription (B070's price catalogue). A change sets the add-on quantity to
 *   `seats - 5` (the item is added, updated, or removed at 0), with proration
 *   (`create_prorations`).
 * - **Bounds:** at most BILLING_MAX_SEATS (default 500; B071's key); never fewer than the seats in
 *   use (B030: members plus pending invites), a 409 `conflict` (`seats_in_use`) that calls no
 *   Stripe; and Team includes 5. Pro (one seat) and the free plan are a 409 (`single_seat_plan`); a
 *   canceled subscription or none in effect a 409 (`subscription_inactive`).
 * - **Serialised with invites:** the count and the Stripe update run under the workspace's seat
 *   lock (B030's advisory lock, as a session lock: no transaction is open across Stripe), so an
 *   invite added at the same moment cannot slip in under a decrease: one of them waits, and B030's
 *   gate checks against `max_seats` as it is once it holds the lock.
 * - **Stripe first:** nothing changes locally until Stripe accepted the update. Its idempotency key
 *   is derived from the caller, the request's Idempotency-Key (else its request id), and the
 *   seats on Stripe before and after. The subscription is read first (under the lock, with the
 *   stored row re-read and re-checked): one that already has the target (an answer lost after
 *   Stripe applied it) is stored without a second write, and nothing at all is done when Stripe
 *   and the stored row both have it. The subscription Stripe returns is stored through
 *   B070's `upsertFromStripe` (stamped with the last stored event's time, so the later webhook
 *   still wins) and handed to B069, which moves entitlements' `rev` (max_seats changes). Stripe
 *   unreachable is 503 with `retry_after_s`; a refusal is 500; either way nothing local changed.
 * - **Preview** reads the subscription and asks Stripe for an invoice preview of the change as of
 *   now (`proration_date`): no Stripe write, no database write. The answer is the contract's
 *   `SeatChangeResult` with the proration (the sum of the proration lines that start at that
 *   instant, so earlier changes' pending prorations are left out; integer minor units) and when
 *   it takes effect.
 * - **Reconcile** compares Stripe's seats with the stored ones and the seats in use: a drift is
 *   stored through `upsertFromStripe` (repaired); seats in use above Stripe's seats are logged.
 *
 * Owns: seat changes. Must not: count seats (B030), decide entitlements (B069), apply a change
 * before Stripe accepted it, or keep a transaction open across a Stripe call.
 */
import { createHash } from 'node:crypto';
import { formatTimestamp, money, type Api } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  unavailable,
  validationFailed,
  type Actor,
  type Logger,
  type Metrics,
} from '@centcom/core';
import {
  idempotencyKey,
  StripeError,
  type StripeSub,
  type SubscriptionItemsInput,
} from '../stripe/gateway.js';
import { INCLUDED_SEATS, type PriceCatalog } from '../stripe/price-catalog.js';
import type { BillingRepository, SubscriptionRow } from '../subscriptions/repository.js';
import {
  BILLING_DETAILS,
  STRIPE_RETRY_AFTER_S,
  type BillingService,
} from '../subscriptions/service.js';
import type { SeatAccountingPort, SeatLock, SeatStripe } from './ports.js';

/** The user-facing details (GUIDELINES §3.4: one message table). */
export const SEAT_DETAILS = Object.freeze({
  inUse: 'This workspace uses more seats than that. Remove members or invites first.',
  singleSeat: 'This plan has one seat. Change plans to add seats.',
  inactive: 'This workspace has no subscription in effect.',
  range: 'Seats are out of range.',
  priceMissing: 'Seats cannot be changed right now.',
} as const);

/** The add-on seats of Team, in the subscription statuses a change applies to. */
const IN_EFFECT: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);
const TEAM_INCLUDED = INCLUDED_SEATS.team;

/** A seat change's answer (CT-API-BILLING `SeatChangeResult`). */
export type SeatResult = Api.SeatChangeResult;
/** A preview's answer. */
export type SeatPreview = Api.SeatChangeResult;

/** What reconciling one workspace found. */
export interface ReconcileResult {
  drift: boolean;
  repaired: boolean;
}

/** What a change needs from the request. */
export interface SeatChangeContext {
  /** The request's Idempotency-Key, if any. */
  idempotencyKey?: string | undefined;
  /** The request id, when there is no key. */
  requestId: string;
  /** Queues the `billing.seats` audit event (B036, no transaction: Stripe is not one). */
  audit(event: { fromSeats: number; toSeats: number }): void;
}

/** What the service needs. */
export interface SeatServiceDeps {
  /** B070's repository: the stored subscription. */
  billingRepository: Pick<BillingRepository, 'findSubscription' | 'findCustomer'>;
  /** B070's service: stores what Stripe returned and hands it to B069. */
  billing: Pick<BillingService, 'upsertFromStripe'>;
  /** Null when billing is off (no Stripe key). */
  stripe: SeatStripe | null;
  catalog: PriceCatalog;
  seats: SeatAccountingPort;
  lock: SeatLock;
  /** BILLING_MAX_SEATS (B071's `loadCheckoutConfig().maxSeats`), default 500. */
  maxSeats?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The default upper bound (BILLING_MAX_SEATS). */
export const DEFAULT_MAX_SEATS = 500;

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);

/** A 409 with a stable code in `errors[0].code`. */
const conflict = (code: 'seats_in_use' | 'single_seat_plan' | 'subscription_inactive') =>
  new AppError('conflict', {
    detail:
      code === 'seats_in_use'
        ? SEAT_DETAILS.inUse
        : code === 'single_seat_plan'
          ? SEAT_DETAILS.singleSeat
          : SEAT_DETAILS.inactive,
    errors: [{ pointer: '/seats', code }],
  });

/** Team's seats on `sub`: 5 plus the add-on seat item's quantity. */
export function seatsOf(sub: StripeSub, catalog: PriceCatalog): number {
  let addon = 0;
  for (const item of sub.items) {
    if (catalog.lookup(item.priceId)?.kind === 'seat') addon += item.quantity;
  }
  return TEAM_INCLUDED + addon;
}

/** Seat changes. */
export class SeatService {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly #maxSeats: number;

  constructor(private readonly deps: SeatServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#maxSeats = deps.maxSeats ?? DEFAULT_MAX_SEATS;
  }

  /** Counts an outcome. */
  #count(outcome: string): void {
    this.#metrics.counter('billing_seat_changes_total', { outcome }).inc();
  }

  /** `seats` checked: a whole number from 1 to the maximum, else a 422 at `/seats`. */
  #checkRange(seats: unknown): number {
    if (typeof seats !== 'number' || !Number.isSafeInteger(seats)) {
      throw validationFailed(
        [{ pointer: '/seats', code: 'invalid_type', detail: 'must be a whole number' }],
        SEAT_DETAILS.range,
      );
    }
    if (seats < 1 || seats > this.#maxSeats) {
      throw validationFailed(
        [{ pointer: '/seats', code: 'out_of_range', detail: `must be 1 to ${this.#maxSeats}` }],
        SEAT_DETAILS.range,
      );
    }
    return seats;
  }

  /** The workspace's Team subscription in effect; a 409 otherwise. */
  async #team(workspaceId: string): Promise<SubscriptionRow> {
    return this.#teamOf(await this.deps.billingRepository.findSubscription(workspaceId));
  }

  /** `row` if it is a Team subscription in effect; a 409 otherwise. */
  #teamOf(row: SubscriptionRow | null): SubscriptionRow {
    if (row === null || row.status === 'none') {
      this.#count('single_seat_plan');
      throw conflict('single_seat_plan');
    }
    if (!IN_EFFECT.has(row.status)) {
      this.#count('inactive');
      throw conflict('subscription_inactive');
    }
    if (row.plan !== 'team') {
      this.#count('single_seat_plan');
      throw conflict('single_seat_plan');
    }
    return row;
  }

  /** A 409 when `seats` is below the seats in use, a 422 below Team's included 5. */
  async #checkUse(
    workspaceId: string,
    seats: number,
    db?: Parameters<SeatAccountingPort['seatsInUse']>[1],
  ) {
    let inUse: number;
    try {
      inUse = await this.deps.seats.seatsInUse(workspaceId, db);
    } catch (err) {
      // Fail closed: never assume no seat is in use. The error's kind only: its text can name
      // the database host.
      throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
        cause: new Error(`seat accounting ${err instanceof Error ? err.name : 'failure'}`),
      });
    }
    if (seats < inUse) {
      this.#count('seats_in_use');
      throw conflict('seats_in_use');
    }
    if (seats < TEAM_INCLUDED) {
      throw validationFailed(
        [
          {
            pointer: '/seats',
            code: 'out_of_range',
            detail: `Team includes ${TEAM_INCLUDED} seats`,
          },
        ],
        SEAT_DETAILS.range,
      );
    }
  }

  /** Runs a Stripe call, turning its failures into the API's (nothing local has changed). */
  async #stripe<T>(call: (stripe: SeatStripe) => Promise<T>): Promise<T> {
    const { stripe } = this.deps;
    if (stripe === null) {
      throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
        cause: new Error('billing is off'),
      });
    }
    try {
      return await call(stripe);
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      this.#count('stripe_failed');
      if (err.kind === 'unavailable') {
        this.deps.logger?.warn({}, 'billing.seats_stripe_unavailable');
        throw unavailable(STRIPE_RETRY_AFTER_S, BILLING_DETAILS.stripeUnavailable, {
          cause: new Error(`stripe ${err.kind}`),
        });
      }
      this.deps.logger?.error(
        { stripe_kind: err.kind, status: err.status, stripe_code: err.stripeCode },
        'billing.seats_stripe_failed',
      );
      throw new AppError('internal_error', {
        detail: BILLING_DETAILS.stripeRefused,
        cause: new Error(`stripe ${err.kind} ${err.status ?? ''}`.trim()),
      });
    }
  }

  /** The item update that makes `sub` have `seats` (Team: 5 plus the add-on quantity). */
  #items(sub: StripeSub, row: SubscriptionRow, seats: number): SubscriptionItemsInput['items'] {
    const addon = seats - TEAM_INCLUDED;
    const current = sub.items.find((i) => this.deps.catalog.lookup(i.priceId)?.kind === 'seat');
    if (current !== undefined) {
      return addon === 0
        ? [{ id: current.id, priceId: current.priceId, quantity: 0, deleted: true }]
        : [{ id: current.id, priceId: current.priceId, quantity: addon }];
    }
    if (addon === 0) return [];
    const currency = row.currency === 'EUR' ? 'EUR' : 'USD';
    const priceId = this.deps.catalog.seatPrice(row.interval, currency);
    if (priceId === null) {
      this.deps.logger?.error({ interval: row.interval, currency }, 'billing.seat_price_missing');
      throw new AppError('internal_error', { detail: SEAT_DETAILS.priceMissing });
    }
    return [{ priceId, quantity: addon }];
  }

  /** The answer for `seats` (not a preview). */
  #result(seats: number): SeatResult {
    return { seats, preview: false, proration: null };
  }

  /**
   * Changes the workspace's seats to `seats` (see the module comment). `actor` is the caller (the
   * audit event is the route's); with `ctx.idempotencyKey` it derives Stripe's key.
   */
  async change(
    workspaceId: string,
    actor: Actor,
    seats: unknown,
    ctx: SeatChangeContext,
  ): Promise<SeatResult> {
    const target = this.#checkRange(seats);
    await this.#team(workspaceId);
    const caller = actor.kind === 'user' ? `usr:${actor.userId}` : `key:${actor.keyId}`;
    return this.deps.lock.withWorkspaceLock(workspaceId, async (db) => {
      await this.#checkUse(workspaceId, target, db);
      // Read again under the lock: a webhook may have changed the plan or status meanwhile.
      const current = this.#teamOf(await this.deps.billingRepository.findSubscription(workspaceId));
      const sub = await this.#stripe((s) => s.retrieveSubscription(current.stripeSubscriptionId));
      const before = seatsOf(sub, this.deps.catalog);
      if (before === target && current.seats === target) {
        this.#count('unchanged');
        return this.#result(target);
      }
      // Stripe already has the target (an earlier answer was lost): store it, write nothing. A
      // second write would also differ from the first (the item now exists), and Stripe refuses a
      // reused idempotency key with other parameters. The key names the seats before and after,
      // so a retry after another change is a new write, never Stripe's stored answer replayed.
      const updated =
        before === target
          ? sub
          : await this.#stripe((s) =>
              s.updateSubscriptionItems(
                {
                  subscriptionId: current.stripeSubscriptionId,
                  items: this.#items(sub, current, target),
                  prorationBehavior: 'create_prorations',
                },
                idempotencyKey(
                  workspaceId,
                  `seats-${before}-${target}-${sha256(`${caller}\n${ctx.idempotencyKey ?? ctx.requestId}`)}`,
                ),
              ),
            );
      const result = await this.deps.billing.upsertFromStripe(updated, current.stripeEventCreated);
      const now = result.view?.seats ?? seatsOf(updated, this.deps.catalog);
      ctx.audit({ fromSeats: current.seats, toSeats: now });
      this.#count('changed');
      this.deps.logger?.info(
        { workspace_id: workspaceId, from_seats: current.seats, to_seats: now },
        'billing.seats_changed',
      );
      return this.#result(now);
    });
  }

  /** What changing to `seats` would cost now (see the module comment); no write anywhere. */
  async preview(workspaceId: string, seats: unknown): Promise<SeatPreview> {
    const target = this.#checkRange(seats);
    const row = await this.#team(workspaceId);
    await this.#checkUse(workspaceId, target);
    const customerId = await this.deps.billingRepository.findCustomer(workspaceId);
    if (customerId === null) throw conflict('subscription_inactive');
    const sub = await this.#stripe((s) => s.retrieveSubscription(row.stripeSubscriptionId));
    const items = this.#items(sub, row, target);
    if (items.length === 0) {
      return { seats: target, preview: true, proration: null };
    }
    // Whole seconds: Stripe's proration_date, and the start of this change's proration lines.
    const prorationDate = Math.floor(this.#clock() / 1000);
    const preview = await this.#stripe((s) =>
      s.previewInvoice({
        customerId,
        subscriptionId: row.stripeSubscriptionId,
        items,
        prorationDate,
      }),
    );
    const currency =
      preview.currency === 'EUR' || preview.currency === 'USD' ? preview.currency : null;
    if (currency === null) {
      throw new AppError('internal_error', { detail: BILLING_DETAILS.stripeRefused });
    }
    // This change's proration lines start at `prorationDate`; earlier ones (pending prorations of
    // earlier changes, on the same upcoming invoice) start before it and are not this change's.
    let proration = 0;
    for (const line of preview.lines) {
      if (!line.proration || !Number.isSafeInteger(line.amount)) continue;
      if (line.periodStart !== undefined && line.periodStart !== prorationDate) continue;
      proration += line.amount;
    }
    this.#count('previewed');
    return {
      seats: target,
      preview: true,
      proration: {
        amount: money(proration, currency),
        effective_at: formatTimestamp(new Date(prorationDate * 1000)),
      },
    };
  }

  /**
   * Compares Stripe's seats with the stored ones and the seats in use; stores a drift. A workspace
   * that is not on Team in effect has nothing to reconcile.
   */
  async reconcile(workspaceId: string): Promise<ReconcileResult> {
    const row = await this.deps.billingRepository.findSubscription(workspaceId);
    if (row === null || row.plan !== 'team' || !IN_EFFECT.has(row.status)) {
      return { drift: false, repaired: false };
    }
    const sub = await this.#stripe((s) => s.retrieveSubscription(row.stripeSubscriptionId));
    const stripeSeats = seatsOf(sub, this.deps.catalog);
    let repaired = false;
    const drift = stripeSeats !== row.seats;
    if (drift) {
      const result = await this.deps.billing.upsertFromStripe(sub, row.stripeEventCreated);
      repaired = result.applied;
      this.deps.logger?.warn(
        { workspace_id: workspaceId, stored_seats: row.seats, stripe_seats: stripeSeats, repaired },
        'billing.seats_drift',
      );
    }
    const inUse = await this.deps.seats.seatsInUse(workspaceId);
    if (inUse > stripeSeats) {
      this.deps.logger?.warn(
        { workspace_id: workspaceId, seats: stripeSeats, in_use: inUse },
        'billing.seats_over_capacity',
      );
    }
    this.#metrics
      .counter('billing_seat_reconciles_total', {
        outcome: drift ? (repaired ? 'repaired' : 'drift') : 'in_sync',
      })
      .inc();
    return { drift, repaired };
  }
}
