/**
 * Usage in the entitlements object (B075 acceptance 4 and 8, card test
 * usage.entitlements-integration.test.ts): B069's `get` carries `usage.hosted_minutes_month` and
 * `usage.queue_items_month` from the relay's meters (never client agent_minutes) and `warnings`
 * from the period's crossings; wrapped by B030's `withSeatUsage`, `usage.seats` is the seats in
 * use, not Stripe's quantity. The reader reads stored state only, so B069 building the object
 * never calls back into the quota service.
 */
import { describe, expect, it } from 'vitest';
import type { SeatService } from '../../../src/modules/seats/service.js';
import { withSeatUsage } from '../../../src/modules/seats/service.js';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { createUsageReader } from '../../../src/modules/usage/reader.js';
import { serviceHarness } from '../../entitlements/helpers.js';
import { MemoryCounterStore, usageHarness } from './helpers.js';

describe('usage in the entitlements object', () => {
  it('carries the relay meters and the crossings as warnings', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    await h.subscribe(ws, 'pro', calendarMonth(new Date(h.clock.now)));
    h.ingest(
      ws,
      'agent_minutes',
      50_000,
      new Date(h.clock.now - 60_000),
      new Date(h.clock.now - 120_000),
    );
    h.relay.record(ws, 'hosted_minutes', 6000);
    h.relay.record(ws, 'queue_items', 12);
    await h.aggregator.run();
    const ent = await h.service.get(ws);
    expect(ent?.usage).toEqual({ hosted_minutes_month: 6000, queue_items_month: 12 });
    expect(ent?.warnings).toEqual([{ limit: 'hosted_minutes_month', pct: 100 }]);
  });

  it("takes seats from B030's seats in use, not Stripe's quantity", async () => {
    const counters = new MemoryCounterStore();
    const seats = {
      usage: () => Promise.resolve({ members: 4, pending_invites: 2, total: 6 }),
    } as unknown as SeatService;
    const h = serviceHarness({ usage: withSeatUsage(seats, createUsageReader(counters)) });
    const ws = h.workspace();
    await h.service.applySubscriptionState(ws, {
      plan: 'team',
      status: 'active',
      period: calendarMonth(new Date(h.clock.now)),
      past_due_since: null,
      addon_seats: 10,
    });
    const ent = await h.service.get(ws);
    expect(ent?.usage?.seats).toBe(4);
    expect(ent?.limits.max_seats).toBe(15);
  });
});
