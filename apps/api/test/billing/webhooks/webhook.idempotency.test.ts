/**
 * Duplicate and concurrent deliveries (B072; tests "webhook.idempotency.test.ts", acceptance 2):
 * the same event id delivered 5 times (one after another, or at once) yields one stored event,
 * one queued job, one processing run and 200 for every delivery; a second job for a processed
 * event does nothing; a queue failure still answers 200 (the event is stored) and the sweep's
 * `waiting` finds it.
 */
import { describe, expect, it } from 'vitest';
import { eventBody, subscriptionObject, webhookHarness } from './helpers.js';

describe('duplicate deliveries', () => {
  it('stores, queues and processes an event once for 5 deliveries (acceptance 2)', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer();
    const { id, body } = eventBody('customer.subscription.updated', subscriptionObject(sub));
    for (let i = 0; i < 5; i++) {
      const res = await h.deliver(body);
      expect(res.statusCode).toBe(200);
    }
    expect(h.events.rows.size).toBe(1);
    expect(h.queued).toEqual([id]);
    await h.drain();
    expect(h.stripe.retrieves).toBe(1);
    expect(h.events.rows.get(id)).toMatchObject({ status: 'processed', attempts: 1 });
    // A stray second job for the same event does nothing.
    expect(await h.processor.process(id)).toBe('skipped');
    expect(h.stripe.retrieves).toBe(1);
    expect(h.recorded.count('stripe_webhooks_total', { outcome: 'duplicate' })).toBe(4);
    await h.app.close();
  });

  it('stores an event once when 5 deliveries arrive at once', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer();
    const { body } = eventBody('customer.subscription.updated', subscriptionObject(sub));
    const results = await Promise.all(Array.from({ length: 5 }, () => h.deliver(body)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(h.events.rows.size).toBe(1);
    expect(h.queued).toHaveLength(1);
    await h.app.close();
  });

  it('answers 200 when the queue is down, and the sweep finds the event', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer();
    const { id, body } = eventBody('customer.subscription.updated', subscriptionObject(sub));
    h.queue.fail = true;
    expect((await h.deliver(body)).statusCode).toBe(200);
    expect(h.queued).toEqual([]);
    expect(h.recorded.count('stripe_event_enqueue_failures_total')).toBe(1);
    h.clock.now += 61_000;
    expect(await h.events.waiting(new Date(h.clock.now - 60_000), 10)).toEqual([id]);
    await h.app.close();
  });
});
