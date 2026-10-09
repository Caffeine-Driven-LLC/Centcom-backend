/**
 * Fixtures for the seat tests (B073):
 *
 * - `FakeSeatStripe`: B070's gateway calls a seat change makes. It keeps subscriptions, applies an
 *   item update once per idempotency key (a reused key with other parameters is refused, as Stripe
 *   does), previews invoices with a proration line for the seats added or removed (800 minor units
 *   a seat, starting at the preview's `prorationDate`), an earlier change's pending proration when
 *   asked, and a recurring line, records every call (reads and writes apart), and can be scripted
 *   to fail, to lose an answer after applying, or to stall.
 * - `memoryLock`: the seat lock in one process (a queue per workspace), with what held it.
 * - `seatsInUse`: B030's count, scripted per workspace, which can fail.
 * - `seatsApp`: the seat route on the workspace routes' plugin stack (B021 RBAC, B024
 *   idempotency, B036 audit) over B070's in-memory billing and an entitlements spy that also
 *   keeps the last subscription state B069 was given.
 *
 * Secret-looking values (Stripe ids) are built at run time.
 */
import type { AuditDb } from '@centcom/core';
import type { SubscriptionState } from '../../../src/modules/entitlements/index.js';
import {
  StripeError,
  type PreviewInput,
  type StripeInvoicePreview,
  type StripeSub,
  type SubscriptionItemsInput,
} from '../../../src/modules/billing/stripe/gateway.js';
import type { SeatLock, SeatStripe } from '../../../src/modules/billing/seats/ports.js';
import { SeatService } from '../../../src/modules/billing/seats/service.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { seatRoutes } from '../../../src/routes/seats/index.js';
import { asUser, createWorkspace, workspacesApp } from '../../modules/workspaces/helpers.js';
import { entitlementsSpy } from '../promotions/helpers.js';
import {
  catalog,
  FakeStripe,
  memoryBilling,
  newId,
  stripeId,
  stripeSub,
} from '../subscriptions/helpers.js';

export { newId, stripeId, stripeSub };

/** What a seat costs in a preview, in minor units. */
export const SEAT_PRICE = 800;
/** The add-on seat price of the tests' subscriptions (team, monthly, EUR). */
export const SEAT_PRICE_ID = 'price_seatmonthEUR';

/** A recorded Stripe call. */
export interface SeatStripeCall {
  kind: 'retrieve' | 'update' | 'preview';
  input?: SubscriptionItemsInput | PreviewInput;
  key?: string;
}

/** A fake Stripe for seat changes (see the module comment). */
export class FakeSeatStripe implements SeatStripe {
  readonly subscriptions = new Map<string, StripeSub>();
  readonly calls: SeatStripeCall[] = [];
  readonly byKey = new Map<string, { params: string; result: StripeSub }>();
  readonly failures: Partial<Record<SeatStripeCall['kind'], Error[]>> = {};
  /** Errors the next updates throw after Stripe applied them (a lost answer). */
  readonly lostAnswers: Error[] = [];
  /** While set, updates wait for it. */
  gate: Promise<void> | null = null;
  /** An earlier change's proration still pending on the upcoming invoice (minor units), if any. */
  pendingProration: number | null = null;

  #fail(kind: SeatStripeCall['kind']): void {
    const failure = this.failures[kind]?.shift();
    if (failure !== undefined) throw failure;
  }

  /** The writes made. */
  writes(): SeatStripeCall[] {
    return this.calls.filter((c) => c.kind === 'update');
  }

  /** Stripe's seats of `id` (5 plus the add-on quantity). */
  seats(id: string): number {
    const sub = this.subscriptions.get(id);
    const addon = sub?.items.find((i) => i.priceId === SEAT_PRICE_ID)?.quantity ?? 0;
    return 5 + addon;
  }

  async retrieveSubscription(id: string): Promise<StripeSub> {
    this.calls.push({ kind: 'retrieve' });
    this.#fail('retrieve');
    const sub = this.subscriptions.get(id);
    if (sub === undefined) throw new StripeError('request', 'No such subscription', 404);
    return Promise.resolve(structuredClone(sub));
  }

  async updateSubscriptionItems(input: SubscriptionItemsInput, key: string): Promise<StripeSub> {
    this.calls.push({ kind: 'update', input: structuredClone(input), key });
    if (this.gate !== null) await this.gate;
    this.#fail('update');
    const params = JSON.stringify(input);
    const earlier = this.byKey.get(key);
    if (earlier !== undefined) {
      if (earlier.params !== params) {
        throw new StripeError(
          'request',
          'Keys for idempotent requests can only be used with the same parameters',
          400,
          'idempotency_error',
        );
      }
      return structuredClone(earlier.result);
    }
    const sub = this.subscriptions.get(input.subscriptionId);
    if (sub === undefined) throw new StripeError('request', 'No such subscription', 404);
    for (const item of input.items) {
      if (item.id !== undefined) {
        const index = sub.items.findIndex((i) => i.id === item.id);
        if (item.deleted === true) sub.items.splice(index, 1);
        else {
          const found = sub.items[index];
          if (found !== undefined) sub.items[index] = { ...found, quantity: item.quantity };
        }
      } else {
        sub.items.push({
          id: stripeId('si'),
          priceId: item.priceId,
          quantity: item.quantity,
          periodStart: sub.periodStart,
          periodEnd: sub.periodEnd,
        });
      }
    }
    this.byKey.set(key, { params, result: structuredClone(sub) });
    const lost = this.lostAnswers.shift();
    if (lost !== undefined) throw lost;
    return structuredClone(sub);
  }

  async previewInvoice(input: PreviewInput): Promise<StripeInvoicePreview> {
    this.calls.push({ kind: 'preview', input: structuredClone(input) });
    this.#fail('preview');
    const sub = this.subscriptions.get(input.subscriptionId);
    if (sub === undefined) throw new StripeError('request', 'No such subscription', 404);
    const before = sub.items.find((i) => i.priceId === SEAT_PRICE_ID)?.quantity ?? 0;
    const change = input.items[0];
    const after = change === undefined || change.deleted === true ? 0 : change.quantity;
    const proration = (after - before) * (SEAT_PRICE / 2);
    const start = input.prorationDate ?? Math.floor(Date.now() / 1000);
    const pending =
      this.pendingProration === null
        ? []
        : [{ amount: this.pendingProration, proration: true, periodStart: start - 86_400 }];
    return Promise.resolve({
      currency: sub.currency,
      amountDue: 7900 + after * SEAT_PRICE + proration + (this.pendingProration ?? 0),
      lines: [
        ...pending,
        { amount: proration, proration: true, periodStart: start },
        { amount: 7900 + after * SEAT_PRICE, proration: false },
      ],
      nextPaymentAttempt: null,
    });
  }
}

/** The seat lock in one process: a queue per workspace, recording each holder. */
export function memoryLock() {
  const tails = new Map<string, Promise<unknown>>();
  const held: string[] = [];
  const lock: SeatLock = {
    async withWorkspaceLock(workspaceId, fn) {
      const before = tails.get(workspaceId) ?? Promise.resolve();
      let release = (): void => undefined;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        workspaceId,
        before.then(() => mine),
      );
      await before.catch(() => undefined);
      held.push(workspaceId);
      try {
        return await fn({ isTransaction: false } as unknown as AuditDb);
      } finally {
        release();
      }
    },
  };
  return { lock, held };
}

/** B030's count, scripted per workspace. */
export function seatsInUse(initial: Record<string, number> = {}) {
  const counts = new Map(Object.entries(initial));
  let failing = false;
  return {
    counts,
    fail(on: boolean) {
      failing = on;
    },
    port: {
      seatsInUse: (workspaceId: string) =>
        failing
          ? Promise.reject(new Error('seat accounting down'))
          : Promise.resolve(counts.get(workspaceId) ?? 1),
    },
  };
}

/** Options of the test app. */
export interface SeatsAppOptions {
  clock?: () => number;
  billingOff?: boolean;
  maxSeats?: number;
}

/** The seat route on the workspace routes' stack (see the module comment). */
export async function seatsApp(options: SeatsAppOptions = {}) {
  const billing = memoryBilling();
  const stripe = new FakeSeatStripe();
  const spy = entitlementsSpy();
  const states = new Map<string, SubscriptionState>();
  const entitlements = {
    revs: spy.revs,
    states,
    port: {
      applySubscriptionState(workspaceId: string, state: SubscriptionState) {
        states.set(workspaceId, state);
        return spy.port.applySubscriptionState(workspaceId, state);
      },
    },
  };
  const locks = memoryLock();
  const inUse = seatsInUse();
  const clock = options.clock ?? (() => Date.UTC(2026, 9, 9, 12, 0, 0));
  const billingService = new BillingService({
    repository: billing.repository,
    gateway: new FakeStripe(),
    catalog: catalog(),
    entitlements: entitlements.port,
    clock,
  });
  let service: SeatService | undefined;
  const wapp = await workspacesApp({
    clock,
    beforeReady: async (app, ctx) => {
      service = new SeatService({
        billingRepository: billing.repository,
        billing: billingService,
        stripe: options.billingOff === true ? null : stripe,
        catalog: catalog(),
        seats: inUse.port,
        lock: locks.lock,
        ...(options.maxSeats === undefined ? {} : { maxSeats: options.maxSeats }),
        clock,
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
      });
      await app.register(seatRoutes, { seats: service });
    },
  });
  if (service === undefined) throw new Error('seatsApp: no service');
  return { ...wapp, billing, stripe, entitlements, locks, inUse, billingService, service };
}

/** An app with a workspace on `plan` (team: 5 plus `addonSeats`), its owner and customer. */
export async function withTeam(
  options: SeatsAppOptions & { plan?: 'pro' | 'team'; addonSeats?: number; status?: string } = {},
) {
  const ctx = await seatsApp(options);
  const owner = newId('usr');
  ctx.store.addUser(owner);
  const ws = (await createWorkspace(ctx.app, owner)).id;
  const customer = stripeId('cus');
  ctx.billing.customers.set(ws, customer);
  const sub = stripeSub(customer, {
    plan: options.plan ?? 'team',
    addonSeats: options.addonSeats ?? 0,
    status: options.status ?? 'active',
  });
  await ctx.billingService.upsertFromStripe(sub, 100);
  ctx.stripe.subscriptions.set(sub.id, structuredClone(sub));
  return { ...ctx, owner, ws, customer, sub };
}

/** The scope a seat change needs. */
export const WRITE = 'billing:write';

/** `PATCH /v1/workspaces/{ws}/seats` as `userId`. */
export function patchSeats(
  ctx: { app: Awaited<ReturnType<typeof seatsApp>>['app'] },
  ws: string,
  userId: string,
  body: unknown,
  options: { preview?: string; headers?: Record<string, string> } = {},
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${ws}/seats${options.preview === undefined ? '' : `?preview=${options.preview}`}`,
    headers: { ...asUser(userId, WRITE), ...(options.headers ?? {}) },
    payload: body as Record<string, unknown>,
  });
}
