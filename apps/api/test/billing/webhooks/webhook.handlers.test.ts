/**
 * What each event type does (B072; tests "webhook.handlers.test.ts"):
 *
 * - `invoice.payment_failed` sets `past_due_since` once (a second failure does not move it),
 *   requests `billing_issue` exactly once per invoice and queues one
 *   `billing.invoice.payment_failed` webhook (acceptance 4);
 * - `customer.subscription.deleted` moves the workspace to `canceled` and applies entitlements
 *   through B069; an update with a plan or seat change stores the new plan and seats
 *   (acceptance 5);
 * - `checkout.session.completed` and `invoice.paid` reconcile, and `invoice.paid` queues its
 *   webhook; a checkout without a subscription is ignored;
 * - unknown event types are stored `ignored` and answered 200; an event for an unknown customer is
 *   `failed` with `unknown_customer` and nothing crashes (acceptance 7);
 * - outgoing events pass B081's real CT-WEBHOOKS checks and notification requests B063's shape.
 */
import { createWebhookEventEmitter } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  eventBody,
  invoiceObject,
  stripeId,
  subscriptionObject,
  webhookHarness,
} from './helpers.js';

describe('invoice.payment_failed (acceptance 4)', () => {
  it('records past_due_since once, notifies once per invoice, and queues the webhook', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer({ plan: 'team' });
    h.stripe.subs.set(sub.id, { ...sub, status: 'past_due' });
    const invoice = invoiceObject(sub);
    const first = eventBody('invoice.payment_failed', invoice, { created: 1_000 });
    expect((await h.deliver(first.body)).statusCode).toBe(200);
    await h.drain();
    const since = h.billingRepo.subscriptions.get(workspaceId)?.pastDueSince;
    expect(since).toBeInstanceOf(Date);

    // Stripe retries the charge an hour later and it fails again: a new event, same invoice.
    h.clock.now += 60 * 60 * 1000;
    const second = eventBody('invoice.payment_failed', invoice, { created: 4_600 });
    await h.deliver(second.body);
    await h.drain();
    expect(h.billingRepo.subscriptions.get(workspaceId)?.pastDueSince).toEqual(since);
    expect(h.billingRepo.subscriptions.get(workspaceId)?.status).toBe('past_due');

    expect(h.notifications).toEqual([
      {
        category: 'billing_issue',
        recipients: { workspace: workspaceId, roles: ['owner', 'billing'] },
        params: { kind: 'payment_failed' },
        priority: 'high',
        dedupeKey: `billing_issue:${String(invoice['id'])}`,
      },
    ]);
    const failed = h.webhooks.filter((w) => w.type === 'billing.invoice.payment_failed');
    expect(failed).toEqual([
      {
        type: 'billing.invoice.payment_failed',
        workspace: workspaceId,
        data: { invoice: invoice['id'], amount: 4900, currency: 'EUR' },
      },
    ]);
    await h.app.close();
  });
});

describe('subscription changes (acceptance 5)', () => {
  it('cancels on customer.subscription.deleted and applies entitlements through B069', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer({ plan: 'pro' });
    await h.deliver(
      eventBody('customer.subscription.created', subscriptionObject(sub), { created: 100 }).body,
    );
    await h.drain();
    h.stripe.subs.set(sub.id, { ...sub, status: 'canceled' });
    await h.deliver(
      eventBody('customer.subscription.deleted', subscriptionObject(sub), { created: 200 }).body,
    );
    await h.drain();
    expect(h.billingRepo.subscriptions.get(workspaceId)?.status).toBe('canceled');
    expect(h.entitlements.calls.map((c) => (c.state as { status: string }).status)).toEqual([
      'active',
      'canceled',
    ]);
    expect(h.webhooks.map((w) => [w.type, w.data['status']])).toEqual([
      ['billing.subscription.updated', 'active'],
      ['billing.subscription.updated', 'canceled'],
    ]);
    await h.app.close();
  });

  it('stores a plan and seat change from customer.subscription.updated', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub, customerId } = h.customer({ plan: 'pro' });
    await h.deliver(
      eventBody('customer.subscription.updated', subscriptionObject(sub), { created: 100 }).body,
    );
    await h.drain();
    expect(h.billingRepo.subscriptions.get(workspaceId)).toMatchObject({ plan: 'pro', seats: 1 });
    const { stripeSub } = await import('./helpers.js');
    const upgraded = { ...stripeSub(customerId, { plan: 'team', addonSeats: 3 }), id: sub.id };
    h.stripe.subs.set(sub.id, upgraded);
    await h.deliver(
      eventBody('customer.subscription.updated', subscriptionObject(upgraded), { created: 200 })
        .body,
    );
    await h.drain();
    expect(h.billingRepo.subscriptions.get(workspaceId)).toMatchObject({ plan: 'team', seats: 8 });
    expect(h.webhooks.at(-1)).toMatchObject({ data: { plan: 'team', seats: 8 } });
    await h.app.close();
  });
});

describe('checkout and invoices', () => {
  it('reconciles checkout.session.completed and invoice.paid; ignores a checkout without a subscription', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer({ plan: 'team' });
    const checkout = eventBody('checkout.session.completed', {
      object: 'checkout.session',
      id: stripeId('cs'),
      customer: sub.customerId,
      subscription: sub.id,
      customer_details: { email: 'buyer@example.test', address: { country: 'DE' } },
    });
    await h.deliver(checkout.body);
    const payment = eventBody('checkout.session.completed', {
      object: 'checkout.session',
      id: stripeId('cs'),
    });
    await h.deliver(payment.body);
    const invoice = invoiceObject(sub, { status: 'paid', amount_paid: 4900, amount_due: 0 });
    await h.deliver(eventBody('invoice.paid', invoice).body);
    await h.drain();
    expect(h.events.rows.get(checkout.id)?.status).toBe('processed');
    expect(h.events.rows.get(payment.id)?.status).toBe('ignored');
    expect(h.billingRepo.subscriptions.get(workspaceId)?.plan).toBe('team');
    expect(h.webhooks.find((w) => w.type === 'billing.invoice.paid')).toEqual({
      type: 'billing.invoice.paid',
      workspace: workspaceId,
      data: { invoice: invoice['id'], amount: 4900, currency: 'EUR' },
    });
    await h.app.close();
  });

  it('handles an invoice without a subscription through its customer', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer();
    const invoice = invoiceObject(sub, { subscription: null, amount_paid: 100 });
    await h.deliver(eventBody('invoice.paid', invoice).body);
    await h.drain();
    expect(h.webhooks).toEqual([
      expect.objectContaining({ type: 'billing.invoice.paid', workspace: workspaceId }),
    ]);
    expect(h.stripe.retrieves).toBe(0);
    await h.app.close();
  });
});

describe('unknown types and customers (acceptance 7)', () => {
  it('stores unknown types as ignored and answers 200, without queueing', async () => {
    const h = await webhookHarness();
    const { id, body } = eventBody('charge.dispute.created', {
      object: 'dispute',
      id: stripeId('dp'),
    });
    expect((await h.deliver(body)).statusCode).toBe(200);
    expect(h.events.rows.get(id)?.status).toBe('ignored');
    expect(h.queued).toEqual([]);
    await h.app.close();
  });

  it('marks an event of an unknown customer failed with unknown_customer, without crashing', async () => {
    const h = await webhookHarness();
    const { stripeSub } = await import('./helpers.js');
    const stranger = stripeSub(stripeId('cus'));
    h.stripe.subs.set(stranger.id, stranger);
    const { id, body } = eventBody('customer.subscription.updated', subscriptionObject(stranger));
    expect((await h.deliver(body)).statusCode).toBe(200);
    expect(await h.processor.process(id)).toBe('failed');
    expect(h.events.rows.get(id)).toMatchObject({
      status: 'failed',
      lastError: 'unknown_customer',
    });
    const orphan = invoiceObject(stranger, { subscription: null });
    const inv = eventBody('invoice.paid', orphan);
    await h.deliver(inv.body);
    expect(await h.processor.process(inv.id)).toBe('failed');
    await h.app.close();
  });
});

describe('outgoing events', () => {
  it('pass B081’s CT-WEBHOOKS checks', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer({ plan: 'team' });
    h.stripe.subs.set(sub.id, { ...sub, status: 'past_due' });
    await h.deliver(eventBody('invoice.payment_failed', invoiceObject(sub)).body);
    await h.deliver(eventBody('invoice.paid', invoiceObject(sub, { amount_paid: 4900 })).body);
    await h.drain();
    const emit = createWebhookEventEmitter({ queue: { add: () => Promise.resolve() } });
    expect(h.webhooks.length).toBeGreaterThanOrEqual(3);
    for (const event of h.webhooks) await expect(emit(event)).resolves.toBeDefined();
    await h.app.close();
  });
});
