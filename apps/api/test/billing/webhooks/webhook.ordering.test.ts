/**
 * Out-of-order and stale events (B072; tests "webhook.ordering.test.ts", acceptance 3): whatever
 * order a subscription's events arrive in (and however often each is delivered), the stored
 * subscription ends equal to what Stripe's current object says, and B069's `rev` moves only on a
 * real change. A property test over random orders and duplicates (fast-check), plus the card's
 * example: `updated` created at T2 arriving before the one created at T1.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eventBody, subscriptionObject, webhookHarness } from './helpers.js';

describe('ordering', () => {
  it('ends at Stripe’s current state when T2 arrives before T1 (acceptance 3)', async () => {
    const h = await webhookHarness();
    const { workspaceId, sub } = h.customer({ plan: 'pro' });
    // Stripe now says: team with 2 add-on seats (the T2 change).
    const { stripeSub } = await import('./helpers.js');
    const current = { ...stripeSub(sub.customerId, { plan: 'team', addonSeats: 2 }), id: sub.id };
    h.stripe.subs.set(sub.id, current);
    const t2 = eventBody('customer.subscription.updated', subscriptionObject(current), {
      created: 2_000,
    });
    const t1 = eventBody('customer.subscription.updated', subscriptionObject(sub), {
      created: 1_000,
    });
    await h.deliver(t2.body);
    await h.deliver(t1.body);
    await h.drain();
    expect(h.billingRepo.subscriptions.get(workspaceId)).toMatchObject({ plan: 'team', seats: 7 });
    expect(h.entitlements.revs.get(workspaceId)?.rev).toBe(1);
    // The late T1 changed nothing and announced nothing.
    expect(h.webhooks).toHaveLength(1);
    await h.app.close();
  });

  it('converges to Stripe’s current object for any order of events and duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 12 }),
        async (order) => {
          const h = await webhookHarness();
          const { workspaceId, sub } = h.customer({ plan: 'team' });
          const { stripeSub } = await import('./helpers.js');
          const final = {
            ...stripeSub(sub.customerId, { plan: 'team', addonSeats: 4 }),
            id: sub.id,
            status: 'past_due',
          };
          h.stripe.subs.set(sub.id, final);
          const events = Array.from({ length: 6 }, (_, i) =>
            eventBody('customer.subscription.updated', subscriptionObject(sub), {
              created: 1_000 + i,
            }),
          );
          for (const i of order) await h.deliver(events[i]?.body ?? '');
          await h.drain();
          const stored = h.billingRepo.subscriptions.get(workspaceId);
          expect(stored).toMatchObject({ plan: 'team', seats: 9, status: 'past_due' });
          // One real change (none → team/past_due): rev moved once, however many events applied.
          expect(h.entitlements.revs.get(workspaceId)?.rev).toBe(1);
          await h.app.close();
        },
      ),
      { numRuns: 40 },
    );
  });
});
