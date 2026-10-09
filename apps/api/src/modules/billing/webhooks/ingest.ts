/**
 * Stripe webhook ingestion (B072): verify, store once, queue, answer.
 *
 * 1. The signature is checked on the exact raw bytes before anything is parsed (B070's
 *    `constructEvent`: HMAC-SHA256, constant-time, 300 s tolerance, either of two secrets while
 *    rolling). A bad, stale or tampered signature, or a body that is not a Stripe event, is a
 *    `WebhookRejected` (the route answers 400) and nothing is stored.
 * 2. The event is stored in one insert (`stripe_event`, unique on its id) with a reduced copy of
 *    its object (`reduceObject`): `received` for a handled type, `ignored` for any other. A
 *    duplicate delivery finds the row: `duplicate`, nothing else happens. A database failure
 *    throws (the route answers 500, so Stripe redelivers): nothing is acknowledged unstored.
 * 3. A newly stored, handled event is queued (`stripe.event.process`, job id the event id). A
 *    queue failure is logged and counted, not thrown: the sweep queues events left `received`.
 *
 * Owns: the webhook's front door. Must not: parse before verifying, keep card data, or log the
 * signature header, the secret or the body.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { StripeError, type StripeGateway } from '../stripe/gateway.js';
import { HANDLED_TYPES, reduceObject } from './handlers.js';
import type { StripeEventStore } from './store.js';

/** A webhook the endpoint refuses (400). */
export class WebhookRejected extends Error {
  override name = 'WebhookRejected';
  constructor(readonly reason: 'signature' | 'payload' | 'not_configured') {
    super(`stripe webhook rejected: ${reason}`);
  }
}

/** Where stored events are queued for processing. */
export interface EventQueue {
  enqueue(eventId: string): Promise<void>;
}

/** What ingestion needs. */
export interface WebhookIngestDeps {
  gateway: Pick<StripeGateway, 'constructEvent'>;
  events: Pick<StripeEventStore, 'insert'>;
  queue: EventQueue;
  logger?: Logger;
  metrics?: Metrics;
}

const EVENT_ID = /^evt_[A-Za-z0-9]{1,250}$/;
const EVENT_TYPE = /^[a-z_.]{1,100}$/;

/** Ingests Stripe webhooks. */
export class WebhookIngest {
  readonly #metrics: Metrics;

  constructor(private readonly deps: WebhookIngestDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Verifies and stores one delivery (see the module comment). `now` is the receipt time. */
  async handle(
    rawBody: Buffer,
    sigHeader: string,
    now: Date = new Date(),
  ): Promise<{ status: 'stored' | 'duplicate' }> {
    let event;
    try {
      event = this.deps.gateway.constructEvent(rawBody, sigHeader);
    } catch (err) {
      const reason =
        err instanceof StripeError && err.kind === 'not_configured'
          ? 'not_configured'
          : err instanceof StripeError && err.kind === 'signature'
            ? 'signature'
            : 'payload';
      this.#metrics.counter('stripe_webhooks_total', { outcome: `rejected_${reason}` }).inc();
      this.deps.logger?.warn({ reason }, 'stripe_webhook.rejected');
      throw new WebhookRejected(reason);
    }
    if (
      !EVENT_ID.test(event.id) ||
      !EVENT_TYPE.test(event.type) ||
      !Number.isSafeInteger(event.created)
    ) {
      this.#metrics.counter('stripe_webhooks_total', { outcome: 'rejected_payload' }).inc();
      throw new WebhookRejected('payload');
    }
    const handled = HANDLED_TYPES.has(event.type);
    const inserted = await this.deps.events.insert({
      eventId: event.id,
      type: event.type,
      created: event.created,
      object: reduceObject(event.object),
      status: handled ? 'received' : 'ignored',
    });
    if (!inserted) {
      this.#metrics.counter('stripe_webhooks_total', { outcome: 'duplicate' }).inc();
      return { status: 'duplicate' };
    }
    this.#metrics
      .counter('stripe_webhooks_total', { outcome: handled ? 'stored' : 'ignored' })
      .inc();
    if (handled) {
      try {
        await this.deps.queue.enqueue(event.id);
      } catch {
        this.#metrics.counter('stripe_event_enqueue_failures_total').inc();
        this.deps.logger?.warn({ event_id: event.id }, 'stripe_webhook.enqueue_failed');
      }
    }
    this.deps.logger?.info(
      { event_id: event.id, type: event.type, received_at: now.toISOString() },
      'stripe_webhook.stored',
    );
    return { status: 'stored' };
  }
}
