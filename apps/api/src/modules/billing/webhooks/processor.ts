/**
 * Processing stored Stripe events (B072): the `stripe.event.process` job's work.
 *
 * - `process(eventId)` claims the event (one worker at a time; a processed, ignored or failed
 *   event is not claimed again, so a duplicate job does nothing), runs its handler and records
 *   the outcome. After a success it publishes the billing outbox (best effort: the sweep retries).
 * - **Permanent failures** are recorded and not retried: a subscription of no known workspace is
 *   `failed` with `unknown_customer`, one selling no known plan `failed` with `unknown_plan`.
 * - **Other failures** (Stripe unavailable, the database, B069) are thrown for the job to retry,
 *   with a safe code in `last_error` (`stripe_unavailable`, `handler_error`). On the last attempt
 *   the event is marked `failed` and the job goes to the dead-letter queue.
 * - `replayEvent(eventId)` reprocesses a stored event whatever its status (after a fix); handlers
 *   are idempotent, so replaying a processed one changes nothing.
 *
 * Owns: the event's states. Must not: log a payload, an amount or a customer id.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { StripeError } from '../stripe/gateway.js';
import { BillingStateError } from '../subscriptions/service.js';
import { handleEvent, type HandlerDeps } from './handlers.js';
import type { StripeEventStore } from './store.js';

/** What processing an event came to. */
export type ProcessOutcome = 'processed' | 'ignored' | 'failed' | 'skipped';

/** What the processor needs. */
export interface EventProcessorDeps extends HandlerDeps {
  events: StripeEventStore;
  /** Publishes the billing outbox (`publishOutbox` with B081's emitter and B063's dispatcher). */
  publish?: () => Promise<unknown>;
  logger?: Logger;
  metrics?: Metrics;
}

/** The safe code of a retryable failure. */
function errorCode(err: unknown): string {
  if (err instanceof StripeError)
    return err.kind === 'unavailable' ? 'stripe_unavailable' : 'stripe_error';
  return 'handler_error';
}

/** Processes stored Stripe events. */
export class EventProcessor {
  readonly #metrics: Metrics;

  constructor(private readonly deps: EventProcessorDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Processes event `eventId` (see the module comment). */
  async process(
    eventId: string,
    opts: { finalAttempt?: boolean; force?: boolean } = {},
  ): Promise<ProcessOutcome> {
    const { events, logger } = this.deps;
    const event = await events.claim(eventId, { force: opts.force === true });
    if (event === null) return 'skipped';
    const fields = { event_id: eventId, type: event.type, attempt: event.attempts };
    let outcome: 'processed' | 'ignored';
    try {
      outcome = await handleEvent(event, this.deps);
    } catch (err) {
      if (err instanceof BillingStateError) {
        const reason = err.reason === 'unknown_workspace' ? 'unknown_customer' : 'unknown_plan';
        await events.finish(eventId, 'failed', reason);
        this.#metrics.counter('stripe_events_total', { outcome: reason }).inc();
        logger?.warn({ ...fields, reason }, 'stripe_event.unusable');
        return 'failed';
      }
      const code = errorCode(err);
      if (opts.finalAttempt === true) {
        await events.finish(eventId, 'failed', code);
        this.#metrics.counter('stripe_events_total', { outcome: 'failed' }).inc();
        logger?.error({ ...fields, error: code }, 'stripe_event.failed');
      } else {
        await events.release(eventId, code);
        logger?.info({ ...fields, error: code }, 'stripe_event.retry');
      }
      throw err;
    }
    await events.finish(eventId, outcome);
    this.#metrics.counter('stripe_events_total', { outcome }).inc();
    logger?.info({ ...fields, outcome }, 'stripe_event.done');
    if (outcome === 'processed' && this.deps.publish !== undefined) {
      try {
        await this.deps.publish();
      } catch {
        this.#metrics.counter('billing_outbox_publish_failures_total', { type: 'run' }).inc();
      }
    }
    return outcome;
  }

  /** Reprocesses a stored event whatever its status; throws when its handler still fails. */
  async replayEvent(eventId: string): Promise<void> {
    const outcome = await this.process(eventId, { force: true, finalAttempt: true });
    if (outcome === 'skipped') throw new Error(`replayEvent: no stored event ${eventId}`);
  }
}
