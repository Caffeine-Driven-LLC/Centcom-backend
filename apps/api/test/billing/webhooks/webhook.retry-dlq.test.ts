/**
 * Retries and replay (B072; tests "webhook.retry-dlq.test.ts", acceptance 6), processor side: a
 * handler that keeps failing is thrown for the job to retry, with a safe code in `last_error`,
 * for 7 attempts; on the 8th (the last) the event is marked `failed`. `replayEvent` reprocesses it
 * once the cause is fixed, and replaying again changes nothing. The job's side (8 attempts,
 * backoff, the dead-letter queue, the sweep) is in apps/worker/test/stripe-event-process.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { eventBody, subscriptionObject, webhookHarness } from './helpers.js';

const ATTEMPTS = 8;

describe('retries and replay (acceptance 6)', () => {
  it('fails the event on the last of 8 attempts, then replays it after a fix', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer({ plan: 'pro' });
    const { id, body } = eventBody('customer.subscription.updated', subscriptionObject(sub));
    await h.deliver(body);
    h.stripe.failures.push(
      ...Array.from({ length: ATTEMPTS }, () => new StripeError('unavailable', 'stripe down', 503)),
    );
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await expect(
        h.processor.process(id, { finalAttempt: attempt === ATTEMPTS }),
      ).rejects.toBeInstanceOf(StripeError);
      expect(h.events.rows.get(id)?.status).toBe(attempt < ATTEMPTS ? 'processing' : 'failed');
    }
    expect(h.events.rows.get(id)).toMatchObject({
      status: 'failed',
      attempts: ATTEMPTS,
      lastError: 'stripe_unavailable',
    });
    expect(h.billingRepo.subscriptions.get(workspaceId)).toBeUndefined();
    // A further job for the failed event does nothing.
    expect(await h.processor.process(id)).toBe('skipped');

    // Stripe is back: an operator replays the event.
    await h.processor.replayEvent(id);
    expect(h.events.rows.get(id)?.status).toBe('processed');
    expect(h.billingRepo.subscriptions.get(workspaceId)?.plan).toBe('pro');
    await h.processor.replayEvent(id);
    expect(h.entitlements.revs.get(workspaceId)?.rev).toBe(1);
    await expect(h.processor.replayEvent('evt_missing')).rejects.toThrow('no stored event');
    await h.app.close();
  });

  it('records a non-Stripe failure as handler_error', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer();
    const { id, body } = eventBody('customer.subscription.updated', subscriptionObject(sub));
    await h.deliver(body);
    h.stripe.failures.push(new StripeError('request', 'bad', 400));
    await expect(h.processor.process(id)).rejects.toBeInstanceOf(StripeError);
    expect(h.events.rows.get(id)?.lastError).toBe('stripe_error');
    h.entitlements.applySubscriptionState = () => Promise.reject(new Error('b069 down'));
    await expect(h.processor.process(id, { finalAttempt: true })).rejects.toThrow('b069 down');
    expect(h.events.rows.get(id)).toMatchObject({ status: 'failed', lastError: 'handler_error' });
    await h.app.close();
  });
});
