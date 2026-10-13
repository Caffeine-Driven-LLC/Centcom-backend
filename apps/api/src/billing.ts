/**
 * Billing in the API process (B070-B072 wired): Stripe's gateway, the subscription and checkout
 * services, the webhook ingest and the event processor the worker runs. Built only when
 * STRIPE_SECRET_KEY is set; without it the billing routes are left out and the deployment runs on
 * `SELF_HOST_PLAN` (or Free).
 *
 * Owns: assembling the billing services over the API's database. Must not: read the environment,
 * hold a Stripe key outside the gateway, or decide what a plan allows (that is B069).
 */
import type { Logger, Metrics } from '@centcom/core';
import type { BillingDb, StripeEventsDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import type { ApiConfig } from './config.js';
import { CheckoutService } from './modules/billing/checkout/service.js';
import type { EntitlementService } from './modules/entitlements/service.js';
import { StripeClient } from './modules/billing/stripe/stripe-client.js';
import type { StripeGateway } from './modules/billing/stripe/gateway.js';
import { BillingService } from './modules/billing/subscriptions/service.js';
import { createBillingRepository } from './modules/billing/subscriptions/repository.js';
import { WebhookIngest, type EventQueue } from './modules/billing/webhooks/ingest.js';
import { EventProcessor } from './modules/billing/webhooks/processor.js';
import { createOutboxStore } from './modules/billing/webhooks/outbox.js';
import { createStripeEventStore } from './modules/billing/webhooks/store.js';

/** What the billing services need. */
export interface BillingDeps {
  config: ApiConfig;
  db: Kysely<unknown>;
  entitlementService: EntitlementService;
  logger: Logger;
  metrics: Metrics;
  clock: () => number;
  /** Where stored events are queued; default none (the worker's sweep picks them up within a minute). */
  eventQueue?: EventQueue;
  /** For tests: a gateway other than the real Stripe client. */
  gateway?: StripeGateway;
}

/** The assembled billing services. */
export interface Billing {
  gateway: StripeGateway;
  billing: BillingService;
  checkout: CheckoutService;
  ingest: WebhookIngest;
  /** Run by the worker's `stripe.event.process` queue. */
  processor: EventProcessor;
  events: ReturnType<typeof createStripeEventStore>;
}

/** The billing services, or null when Stripe is not configured. */
export function createBilling(deps: BillingDeps): Billing | null {
  const { config, logger, metrics, clock } = deps;
  const settings = config.billing;
  if (settings === null) return null;
  const view = <DB>(): Kysely<DB> => deps.db as unknown as Kysely<DB>;
  const gateway = deps.gateway ?? new StripeClient({ config: settings.stripe, clock });
  const repository = createBillingRepository(view<BillingDb>());
  const billing = new BillingService({
    repository,
    gateway,
    catalog: settings.prices,
    entitlements: deps.entitlementService,
    clock,
    logger,
    metrics,
  });
  const checkout = new CheckoutService({
    gateway,
    billing,
    repository,
    catalog: settings.prices,
    config: settings.checkout,
    logger,
    metrics,
  });
  const events = createStripeEventStore(view<StripeEventsDatabase>());
  const ingest = new WebhookIngest({
    gateway,
    events,
    queue: deps.eventQueue ?? { enqueue: () => Promise.resolve() },
    logger,
    metrics,
  });
  const processor = new EventProcessor({
    events,
    gateway,
    billing,
    outbox: createOutboxStore(view<StripeEventsDatabase>()),
    workspaceOfCustomer: (customerId) => repository.workspaceOfCustomer(customerId),
    clock,
    logger,
    metrics,
  });
  return { gateway, billing, checkout, ingest, processor, events };
}
