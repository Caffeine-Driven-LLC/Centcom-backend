/**
 * Test helpers for Stripe webhooks (B072): signed deliveries made the way the Stripe CLI signs them
 * (`t=<unix>,v1=<HMAC-SHA256 of "t.body">` with a test secret), event bodies, a scripted Stripe
 * (B070's real `constructEvent`, subscriptions the test sets), in-memory event and outbox stores
 * with the Postgres stores' rules, a fake B069 whose `rev` moves only on a real change, and the
 * webhook route on the API's plugin stack.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { Secret, type NotificationEvent, type WebhookEventInput } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import type { StripeSub } from '../../../src/modules/billing/stripe/gateway.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { StripeClient } from '../../../src/modules/billing/stripe/stripe-client.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import {
  EventProcessor,
  WebhookIngest,
  publishOutbox,
  type NewEvent,
  type OutboxEntry,
  type OutboxRow,
  type OutboxStore,
  type StoredEvent,
  type StripeEventStore,
} from '../../../src/modules/billing/webhooks/index.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { stripeWebhookRoutes } from '../../../src/routes/stripe-webhook/index.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { memoryTokens } from '../../modules/auth/tokens/helpers.js';
import {
  catalog,
  memoryBilling,
  newId,
  stripeId,
  stripeSub,
  testSecretKey,
} from '../subscriptions/helpers.js';

export { newId, stripeId, stripeSub };

/** A webhook signing secret, built here so no secret-shaped literal sits in the source. */
export const webhookSecret = (tag = 'A'): string =>
  ['whsec', `test${tag}${'0123456789abcdefghij'.repeat(2)}`].join('_');

/** The `Stripe-Signature` header of `body` at `t` (Unix seconds) with `secret`. */
export function sign(body: string, secret: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** A Stripe event body. */
export function eventBody(
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; created?: number } = {},
): { id: string; body: string } {
  const id = opts.id ?? stripeId('evt');
  const body = JSON.stringify({
    id,
    object: 'event',
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object },
  });
  return { id, body };
}

/** A raw Stripe subscription object of `sub` (what an event carries). */
export const subscriptionObject = (sub: StripeSub): Record<string, unknown> => ({
  object: 'subscription',
  id: sub.id,
  customer: sub.customerId,
  status: sub.status,
  currency: sub.currency.toLowerCase(),
});

/** A raw invoice object, with the card data and contact details Stripe puts in one. */
export const invoiceObject = (
  sub: StripeSub,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  object: 'invoice',
  id: stripeId('in'),
  customer: sub.customerId,
  subscription: sub.id,
  status: 'open',
  currency: 'eur',
  amount_due: 4900,
  amount_paid: 0,
  customer_email: 'billing@example.test',
  customer_name: 'Ada Lovelace',
  customer_address: { line1: '1 Main St', city: 'Berlin' },
  payment_intent: {
    id: stripeId('pi'),
    payment_method: { card: { last4: '4242', exp_year: 2030 } },
  },
  ...over,
});

/** The event store in memory, by the Postgres store's rules. */
export class MemoryEventStore implements StripeEventStore {
  rows = new Map<string, StoredEvent & { receivedAt: Date }>();
  failInsert = false;
  constructor(private readonly clock: () => number = Date.now) {}

  insert(e: NewEvent): Promise<boolean> {
    if (this.failInsert) return Promise.reject(new Error('db down'));
    if (this.rows.has(e.eventId)) return Promise.resolve(false);
    this.rows.set(e.eventId, {
      eventId: e.eventId,
      type: e.type,
      created: e.created,
      object: JSON.parse(JSON.stringify(e.object)) as Record<string, unknown>,
      status: e.status,
      attempts: 0,
      lastError: null,
      receivedAt: new Date(this.clock()),
    });
    return Promise.resolve(true);
  }
  get(id: string) {
    const r = this.rows.get(id);
    return Promise.resolve(r === undefined ? null : { ...r });
  }
  claim(id: string, opts: { force?: boolean } = {}) {
    const r = this.rows.get(id);
    const ok =
      r !== undefined &&
      (opts.force === true || r.status === 'received' || r.status === 'processing');
    if (!ok || r === undefined) return Promise.resolve(null);
    r.status = 'processing';
    r.attempts += 1;
    return Promise.resolve({ ...r });
  }
  finish(id: string, status: 'processed' | 'ignored' | 'failed', error: string | null = null) {
    const r = this.rows.get(id);
    if (r !== undefined) Object.assign(r, { status, lastError: error });
    return Promise.resolve();
  }
  release(id: string, error: string) {
    const r = this.rows.get(id);
    if (r?.status === 'processing') r.lastError = error;
    return Promise.resolve();
  }
  waiting(before: Date, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) => (r.status === 'received' || r.status === 'processing') && r.receivedAt < before,
        )
        .slice(0, limit)
        .map((r) => r.eventId),
    );
  }
  oldestWaiting() {
    const open = [...this.rows.values()].filter(
      (r) => r.status === 'received' || r.status === 'processing',
    );
    return Promise.resolve(open.length === 0 ? null : (open[0]?.receivedAt ?? null));
  }
}

/** The outbox in memory, unique on (type, dedupe key). */
export class MemoryOutbox implements OutboxStore {
  rows: (OutboxRow & { published: boolean })[] = [];
  add(entry: OutboxEntry): Promise<boolean> {
    if (this.rows.some((r) => r.type === entry.type && r.dedupeKey === entry.dedupeKey)) {
      return Promise.resolve(false);
    }
    this.rows.push({ ...entry, id: String(this.rows.length + 1), published: false });
    return Promise.resolve(true);
  }
  pending(limit: number) {
    return Promise.resolve(
      this.rows
        .filter((r) => !r.published)
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }
  markPublished(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r !== undefined) r.published = true;
    return Promise.resolve();
  }
}

/** A fake B069: records applied states; `rev` moves only when the state really changed. */
export function fakeEntitlements() {
  const revs = new Map<string, { rev: number; digest: string }>();
  const calls: { workspaceId: string; state: unknown }[] = [];
  return {
    revs,
    calls,
    applySubscriptionState(workspaceId: string, state: unknown) {
      calls.push({ workspaceId, state });
      const digest = JSON.stringify(state);
      const current = revs.get(workspaceId);
      if (current?.digest !== digest)
        revs.set(workspaceId, { rev: (current?.rev ?? 0) + 1, digest });
      return Promise.resolve(revs.get(workspaceId));
    },
  };
}

/** Everything a webhook test needs, wired as production wires it, in memory. */
export async function webhookHarness(opts: { secrets?: string[]; clock?: { now: number } } = {}) {
  const clock = opts.clock ?? { now: Date.now() };
  const secrets = opts.secrets ?? [webhookSecret()];
  const client = new StripeClient({
    config: {
      secretKey: new Secret(testSecretKey()),
      apiVersion: '2025-03-31.basil',
      webhookSecret: secrets[0] === undefined ? null : new Secret(secrets[0]),
      webhookSecrets: secrets.map((s) => new Secret(s)),
      apiBase: 'http://127.0.0.1:1',
    },
    clock: () => clock.now,
  });
  /** Stripe's current subscriptions, by id; `failures` makes retrieve throw first. */
  const stripe = {
    subs: new Map<string, StripeSub>(),
    failures: [] as StripeError[],
    retrieves: 0,
  };
  const gateway = {
    constructEvent: (raw: string | Buffer, sig: string) => client.constructEvent(raw, sig),
    retrieveSubscription: (id: string) => {
      stripe.retrieves += 1;
      const failure = stripe.failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      const sub = stripe.subs.get(id);
      return sub === undefined
        ? Promise.reject(new StripeError('request', 'no such subscription', 404))
        : Promise.resolve({ ...sub });
    },
  };
  const billingRepo = memoryBilling();
  const entitlements = fakeEntitlements();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const billing = new BillingService({
    repository: billingRepo.repository,
    gateway: gateway as never,
    catalog: catalog(),
    entitlements,
    clock: () => clock.now,
    logger: captured.logger,
  });
  const events = new MemoryEventStore(() => clock.now);
  const outbox = new MemoryOutbox();
  const webhooks: WebhookEventInput[] = [];
  const notifications: NotificationEvent[] = [];
  const publish = () =>
    publishOutbox({
      outbox,
      emitWebhook: (input) => {
        webhooks.push(input);
        return Promise.resolve();
      },
      notify: {
        publish: (event) => {
          notifications.push(event);
          return Promise.resolve(newId('ntf'));
        },
      },
      logger: captured.logger,
    });
  const processor = new EventProcessor({
    events,
    gateway,
    billing,
    outbox,
    workspaceOfCustomer: (id) => billingRepo.repository.workspaceOfCustomer(id),
    publish,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  /** Jobs queued by ingestion; `drain` runs them (the worker). */
  const queued: string[] = [];
  const queue = {
    fail: false,
    enqueue: (id: string) =>
      queue.fail ? Promise.reject(new Error('redis down')) : (queued.push(id), Promise.resolve()),
  };
  const ingest = new WebhookIngest({
    gateway,
    events,
    queue,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const drain = async (): Promise<void> => {
    while (queued.length > 0) {
      const id = queued.shift() as string;
      await processor.process(id, { finalAttempt: true }).catch(() => undefined);
    }
  };

  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens: memoryTokens().tokens });
  await app.register(stripeWebhookRoutes, { ingest, clock: () => clock.now });
  await app.ready();

  /** A workspace with a Stripe customer, and Stripe's current subscription for it. */
  const customer = (
    sub: Partial<StripeSub> & { plan?: 'pro' | 'team'; addonSeats?: number } = {},
  ) => {
    const workspaceId = newId('wsp');
    const customerId = stripeId('cus');
    billingRepo.customers.set(workspaceId, customerId);
    const current = stripeSub(customerId, sub);
    stripe.subs.set(current.id, current);
    return { workspaceId, customerId, sub: current };
  };

  /** Delivers `body` signed with `secret` at `t` (default now). */
  const deliver = (
    body: string,
    o: { secret?: string; t?: number; signature?: string | null } = {},
  ) => {
    const t = o.t ?? Math.floor(clock.now / 1000);
    const signature =
      o.signature === undefined ? sign(body, o.secret ?? secrets[0] ?? '', t) : o.signature;
    return app.inject({
      method: 'POST',
      url: '/internal/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'stripe-signature': signature }),
      },
      payload: body,
    });
  };

  return {
    app,
    clock,
    stripe,
    billing,
    billingRepo,
    entitlements,
    events,
    outbox,
    webhooks,
    notifications,
    processor,
    ingest,
    queue,
    queued,
    drain,
    publish,
    captured,
    recorded,
    customer,
    deliver,
    secrets,
  };
}

/** Random bytes as base64url (fuzzing helpers). */
export const noise = (n: number): string => randomBytes(n).toString('base64url');
