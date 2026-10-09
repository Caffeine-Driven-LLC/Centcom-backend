/**
 * Fixtures for the trials and promotions tests (B079):
 *
 * - `promotionCode(...)`: Stripe promotion code objects (API 2025-03-31.basil shape: the coupon on
 *   the code, `applies_to` expanded) for the valid, expired, exhausted, wrong-plan, first-time,
 *   other-customer and other-currency cases. Ids are built at run time.
 * - `FakePromotionStripe`: finds active codes case-insensitively, keeps each subscription's
 *   discounts (with the promotion each came from) and products, replays an apply per idempotency
 *   key and refuses the key with other parameters (as Stripe does), counts redemptions and
 *   refuses past `max_redemptions` (so two workspaces racing for a single-use code get one
 *   success), and can be scripted to fail, to lose an answer after applying, or to stall.
 * - `memoryPromotions`: an in-memory PromotionRepository with the Postgres one's rules: the unique
 *   key (the stored fingerprint answered on a conflict), and audit rows kept only when the
 *   "transaction" commits.
 * - `promotionsApp`: the coupon route on the workspace routes' plugin stack (B021 RBAC, B024
 *   idempotency, B036 audit), over B070's in-memory billing and a memory rate limiter.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type AuditDb } from '@centcom/core';
import type { CompiledQuery, QueryResult } from 'kysely';
import type { FastifyRequest } from 'fastify';
import { StripeError, type StripeSub } from '../../../src/modules/billing/stripe/gateway.js';
import type {
  ApplyPromotionInput,
  PromotionStripe,
  SubscriptionDiscounts,
} from '../../../src/modules/billing/promotions/ports.js';
import type {
  PromotionRepository,
  RedemptionRow,
  TrialRow,
} from '../../../src/modules/billing/promotions/repository.js';
import { PromotionService } from '../../../src/modules/billing/promotions/service.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import type { SubscriptionState } from '../../../src/modules/entitlements/ports.js';
import { couponRoutes } from '../../../src/routes/billing-coupons.js';
import { asUser, createWorkspace, workspacesApp } from '../../modules/workspaces/helpers.js';
import {
  catalog,
  FakeStripe,
  memoryBilling,
  stripeId,
  stripeSub,
} from '../subscriptions/helpers.js';

export { newId, stripeId, stripeSub };

/** The product of every catalogue price in these tests. */
export const TEAM_PRODUCT = 'prod_FixtureTeam';
export const PRO_PRODUCT = 'prod_FixturePro';

/** A code made of letters and digits, as Stripe takes them. */
export const newCode = (): string => `SAVE${randomBytes(6).toString('hex').toUpperCase()}`;

/** A promotion code object for `code`, valid unless `overrides` say otherwise. */
export function promotionCode(
  code: string,
  overrides: {
    active?: boolean;
    expires_at?: number | null;
    max_redemptions?: number | null;
    times_redeemed?: number;
    customer?: string | null;
    first_time_transaction?: boolean;
    coupon?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const { coupon = {}, first_time_transaction = false, ...rest } = overrides;
  return {
    id: stripeId('promo'),
    object: 'promotion_code',
    active: true,
    code,
    created: 1_790_000_000,
    customer: null,
    expires_at: null,
    livemode: false,
    max_redemptions: null,
    metadata: { campaign: 'spring' },
    restrictions: {
      first_time_transaction,
      minimum_amount: null,
      minimum_amount_currency: null,
    },
    times_redeemed: 0,
    coupon: {
      id: stripeId('co'),
      object: 'coupon',
      amount_off: null,
      currency: null,
      duration: 'repeating',
      duration_in_months: 3,
      max_redemptions: null,
      name: 'Spring',
      percent_off: 20,
      redeem_by: null,
      times_redeemed: 0,
      valid: true,
      ...coupon,
    },
    ...rest,
  };
}

/** A recorded Stripe call. */
export interface StripeCall {
  kind: 'find' | 'retrieve' | 'discounts' | 'apply' | 'subscription';
  arg: string;
  idempotencyKey?: string;
}

/** A discount on a fake subscription. */
interface FakeDiscount {
  id: string;
  promotionCodeId: string | null;
}

/** A fake Stripe with promotion codes and subscriptions (see the module comment). */
export class FakePromotionStripe implements PromotionStripe {
  readonly codes: Record<string, unknown>[] = [];
  readonly subscriptions = new Map<
    string,
    { sub: StripeSub; discounts: FakeDiscount[]; productIds: string[] }
  >();
  readonly calls: StripeCall[] = [];
  /** Applies already made, by idempotency key: the parameters and the result (Stripe's rule). */
  readonly byKey = new Map<string, { params: string; result: StripeSub }>();
  /** Errors the next calls of a kind throw, in order. */
  readonly failures: Partial<Record<StripeCall['kind'], Error[]>> = {};
  /** Errors the next applies throw after Stripe applied them (a lost answer). */
  readonly lostAnswers: Error[] = [];
  /** While set, applies wait for it. */
  gate: Promise<void> | null = null;

  #fail(kind: StripeCall['kind']): void {
    const failure = this.failures[kind]?.shift();
    if (failure !== undefined) throw failure;
  }

  /** Adds a subscription Stripe knows, with its products. */
  addSubscription(sub: StripeSub, productIds: string[] = [TEAM_PRODUCT]): void {
    this.subscriptions.set(sub.id, { sub, discounts: [], productIds });
  }

  /** The discounts on subscription `id`. */
  discountsOf(id: string): FakeDiscount[] {
    return [...(this.subscriptions.get(id)?.discounts ?? [])];
  }

  async findPromotionCodes(code: string): Promise<unknown[]> {
    this.calls.push({ kind: 'find', arg: code });
    this.#fail('find');
    return Promise.resolve(
      this.codes
        .filter(
          (c) => c['active'] === true && String(c['code']).toUpperCase() === code.toUpperCase(),
        )
        .map((c) => structuredClone(c)),
    );
  }

  async retrievePromotionCode(id: string): Promise<unknown> {
    this.calls.push({ kind: 'retrieve', arg: id });
    this.#fail('retrieve');
    const found = this.codes.find((c) => c['id'] === id);
    if (found === undefined) throw new StripeError('request', 'No such promotion code', 404);
    return Promise.resolve(structuredClone(found));
  }

  async subscriptionDiscounts(subscriptionId: string): Promise<SubscriptionDiscounts> {
    this.calls.push({ kind: 'discounts', arg: subscriptionId });
    this.#fail('discounts');
    const entry = this.subscriptions.get(subscriptionId);
    if (entry === undefined) throw new StripeError('request', 'No such subscription', 404);
    return Promise.resolve({
      discounts: entry.discounts.map((d) => ({ ...d })),
      productIds: [...entry.productIds],
    });
  }

  async retrieveSubscription(id: string): Promise<StripeSub> {
    this.calls.push({ kind: 'subscription', arg: id });
    this.#fail('subscription');
    const entry = this.subscriptions.get(id);
    if (entry === undefined) throw new StripeError('request', 'No such subscription', 404);
    return Promise.resolve(structuredClone(entry.sub));
  }

  async applyPromotionCode(input: ApplyPromotionInput, key: string): Promise<StripeSub> {
    this.calls.push({ kind: 'apply', arg: input.promotionCodeId, idempotencyKey: key });
    if (this.gate !== null) await this.gate;
    this.#fail('apply');
    const params = JSON.stringify(input);
    const earlier = this.byKey.get(key);
    if (earlier !== undefined) {
      // Stripe: the same key with other parameters is refused; with the same ones, replayed.
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
    const entry = this.subscriptions.get(input.subscriptionId);
    const promo = this.codes.find((c) => c['id'] === input.promotionCodeId);
    if (entry === undefined || promo === undefined) {
      throw new StripeError('request', 'No such object', 404);
    }
    const max = promo['max_redemptions'];
    const times = Number(promo['times_redeemed']);
    if (typeof max === 'number' && times >= max) {
      throw new StripeError(
        'request',
        'This promotion code cannot be redeemed',
        400,
        'coupon_expired',
      );
    }
    promo['times_redeemed'] = times + 1;
    const kept = entry.discounts.filter((d) => input.keepDiscountIds.includes(d.id));
    entry.discounts = [...kept, { id: stripeId('di'), promotionCodeId: input.promotionCodeId }];
    this.byKey.set(key, { params, result: entry.sub });
    const lost = this.lostAnswers.shift();
    if (lost !== undefined) throw lost;
    return structuredClone(entry.sub);
  }
}

/** The rows of an `insert into "audit_events"`, column by column. */
function auditRows(query: CompiledQuery): Record<string, unknown>[] {
  const list = /\(([^)]+)\) values/.exec(query.sql)?.[1] ?? '';
  const columns = list.split(', ').map((c) => c.replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < query.parameters.length; at += columns.length) {
    rows.push(Object.fromEntries(columns.map((c, i) => [c, query.parameters[at + i]])));
  }
  return rows;
}

/** The in-memory repository, by the Postgres one's rules. */
export function memoryPromotions(owners: Record<string, string[]> = {}) {
  const redemptions = new Map<string, RedemptionRow>();
  const trials: (Omit<TrialRow, 'ownerUserIds'> & { ownerUserIds: string[] })[] = [];
  /** Audit rows of recorded redemptions. */
  const audit: Record<string, unknown>[] = [];
  const keyOf = (workspaceId: string, promotionId: string) => `${workspaceId}/${promotionId}`;

  const repository: PromotionRepository = {
    findRedemption(workspaceId, promotionId) {
      const row = redemptions.get(keyOf(workspaceId, promotionId));
      return Promise.resolve(
        row === undefined ? null : { requestFingerprint: row.requestFingerprint },
      );
    },
    async record(row, write) {
      const key = keyOf(row.workspaceId, row.stripePromotionId);
      const stored = redemptions.get(key);
      if (stored !== undefined) {
        return { recorded: false, existing: { requestFingerprint: stored.requestFingerprint } };
      }
      const pending: Record<string, unknown>[] = [];
      const trx: AuditDb = {
        isTransaction: true,
        executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
          pending.push(...auditRows(query));
          return Promise.resolve({ rows: [] });
        },
      };
      redemptions.set(key, { ...row });
      try {
        if (write !== undefined) await write(trx);
      } catch (err) {
        redemptions.delete(key);
        throw err;
      }
      audit.push(...pending);
      return { recorded: true };
    },
    recordTrial(trial) {
      const exists = trials.some(
        (t) =>
          t.stripeSubscriptionId === trial.stripeSubscriptionId ||
          t.workspaceId === trial.workspaceId,
      );
      if (!exists) trials.push({ ...trial, ownerUserIds: [...new Set(trial.ownerUserIds)] });
      return Promise.resolve(!exists);
    },
    trialUsed(workspaceId, userIds) {
      return Promise.resolve(
        trials.some(
          (t) => t.workspaceId === workspaceId || t.ownerUserIds.some((u) => userIds.includes(u)),
        ),
      );
    },
    ownersOf(workspaceId) {
      return Promise.resolve([...(owners[workspaceId] ?? [])]);
    },
  };
  return { repository, redemptions, trials, audit, owners };
}

/** An entitlements port that bumps `rev` only when the state it is handed changes. */
export function entitlementsSpy() {
  const states = new Map<string, string>();
  const revs = new Map<string, number>();
  return {
    revs,
    port: {
      applySubscriptionState(workspaceId: string, state: SubscriptionState) {
        const text = JSON.stringify(state);
        const changed = states.get(workspaceId) !== text;
        states.set(workspaceId, text);
        if (changed) revs.set(workspaceId, (revs.get(workspaceId) ?? 0) + 1);
        return Promise.resolve({ rev: revs.get(workspaceId) ?? 0, changed });
      },
    },
  };
}

/** Options of the test app. */
export interface PromotionsAppOptions {
  /** Milliseconds; default a fixed time that tests move. */
  clock?: () => number;
  rateLimit?: boolean;
  redeemRatePerHour?: number;
  billingOff?: boolean;
}

/** The coupon route on the workspace routes' stack (see the module comment). */
export async function promotionsApp(options: PromotionsAppOptions = {}) {
  const billing = memoryBilling();
  const mirror = memoryPromotions();
  const stripe = new FakePromotionStripe();
  const entitlements = entitlementsSpy();
  let now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const clock = options.clock ?? (() => now);
  const limiter = createMemoryRedis(clock);
  const billingService = new BillingService({
    repository: billing.repository,
    gateway: new FakeStripe(),
    catalog: catalog(),
    entitlements: entitlements.port,
    clock,
  });
  let service: PromotionService | undefined;
  const wapp = await workspacesApp({
    clock,
    ...(options.rateLimit === true ? { rateLimit: true } : {}),
    beforeReady: async (app, ctx) => {
      service = new PromotionService({
        repository: mirror.repository,
        billingRepository: billing.repository,
        billing: billingService,
        stripe: options.billingOff === true ? null : stripe,
        rateLimit: limiter.rateLimit,
        locks: limiter.kv,
        config: { redeemRatePerHour: options.redeemRatePerHour ?? 10 },
        clock,
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
      });
      await app.register(couponRoutes, {
        promotions: service,
        clientIp: (request: FastifyRequest) =>
          typeof request.headers['x-test-ip'] === 'string'
            ? request.headers['x-test-ip']
            : '192.0.2.1',
      });
    },
  });
  if (service === undefined) throw new Error('promotionsApp: no service');
  const advance = (ms: number) => {
    now += ms;
  };
  return { ...wapp, billing, mirror, stripe, entitlements, billingService, service, advance };
}

/** An app with a workspace on team (5 + 3 seats, EUR), its owner, customer and subscription. */
export async function withSubscription(options: PromotionsAppOptions = {}, status = 'active') {
  const ctx = await promotionsApp(options);
  const owner = newId('usr');
  ctx.store.addUser(owner);
  const ws = (await createWorkspace(ctx.app, owner)).id;
  const customer = stripeId('cus');
  ctx.billing.customers.set(ws, customer);
  const sub = stripeSub(customer, { addonSeats: 3, status });
  await ctx.billingService.upsertFromStripe(sub, 100);
  ctx.stripe.addSubscription(sub);
  return { ...ctx, owner, ws, customer, sub };
}

/** The scope redeeming needs. */
export const WRITE = 'billing:write';

/** `POST /v1/workspaces/{ws}/coupons/redeem` as `userId`. */
export function redeemAs(
  ctx: { app: Awaited<ReturnType<typeof promotionsApp>>['app'] },
  ws: string,
  userId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${ws}/coupons/redeem`,
    headers: { ...asUser(userId, WRITE), ...headers },
    payload: body as Record<string, unknown>,
  });
}
