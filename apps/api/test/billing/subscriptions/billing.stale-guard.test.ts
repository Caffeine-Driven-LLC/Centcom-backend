/**
 * `upsertFromStripe` (B070 acceptance 7, failure mode "a different currency"): an update from an
 * event older than the stored one changes nothing and is not handed to entitlements; a newer one
 * is applied and handed to B069's `applySubscriptionState`; a replay of the same event is applied
 * again with the same result. Plan, interval and seats come from the price catalogue (team: 5
 * included plus add-on seats); a currency other than the stored one is stored as returned with a
 * warning, plan unchanged; an unknown plan price keeps the stored plan, or is refused for a new
 * subscription; a customer of no workspace is refused. On Postgres 16 (DATABASE_URL), the guard
 * runs in the upsert itself.
 */
import type { BillingDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { SubscriptionState } from '../../../src/modules/entitlements/ports.js';
import { createBillingRepository } from '../../../src/modules/billing/subscriptions/repository.js';
import {
  BillingService,
  BillingStateError,
} from '../../../src/modules/billing/subscriptions/service.js';
import { captureLogger } from '../../helpers.js';
import { pgJoin, pgUser, pgWorkspace } from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import { catalog, FakeStripe, memoryBilling, newId, stripeId, stripeSub } from './helpers.js';

function setup() {
  const billing = memoryBilling();
  const applied: { workspaceId: string; state: SubscriptionState }[] = [];
  const captured = captureLogger();
  const service = new BillingService({
    repository: billing.repository,
    gateway: new FakeStripe(),
    catalog: catalog(),
    entitlements: {
      applySubscriptionState: (workspaceId, state) => {
        applied.push({ workspaceId, state });
        return Promise.resolve({ rev: applied.length, changed: true });
      },
    },
    clock: () => Date.UTC(2026, 9, 8, 12, 0, 0),
    logger: captured.logger,
  });
  const ws = newId('wsp');
  const customer = stripeId('cus');
  billing.customers.set(ws, customer);
  return { billing, applied, captured, service, ws, customer };
}

describe('upsertFromStripe', () => {
  it('ignores an older event and applies a newer one', async () => {
    const { service, applied, ws, customer, billing } = setup();
    const first = await service.upsertFromStripe(stripeSub(customer, { addonSeats: 2 }), 1000);
    expect(first.applied).toBe(true);
    expect(first.view).toMatchObject({ workspace: ws, plan: 'team', status: 'active', seats: 7 });

    const older = await service.upsertFromStripe(
      stripeSub(customer, { status: 'canceled', addonSeats: 9 }),
      999,
    );
    expect(older.applied).toBe(false);
    expect(older.view).toMatchObject({ status: 'active', seats: 7 });
    expect(billing.subscriptions.get(ws)?.stripeEventCreated).toBe(1000);

    const newer = await service.upsertFromStripe(
      stripeSub(customer, { status: 'past_due', addonSeats: 3 }),
      1001,
    );
    expect(newer.applied).toBe(true);
    expect(newer.view).toMatchObject({ status: 'past_due', seats: 8 });
    expect(newer.view?.grace_until).toBe('2026-10-15T12:00:00.000Z');

    expect(applied.map((a) => a.state.status)).toEqual(['active', 'past_due']);
    expect(applied[1]?.state).toMatchObject({ plan: 'team', addon_seats: 3 });
    expect(applied[1]?.state.past_due_since?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('applies a replay of the same event again, with the same result', async () => {
    const { service, applied, customer } = setup();
    const sub = stripeSub(customer);
    const once = await service.upsertFromStripe(sub, 2000);
    const again = await service.upsertFromStripe(sub, 2000);
    expect(again).toEqual(once);
    expect(applied).toHaveLength(2);
    expect(applied[0]?.state).toEqual(applied[1]?.state);
  });

  it('keeps the subscription id across updates, and a canceled one stays shown until its period ends', async () => {
    const { service, customer } = setup();
    const first = await service.upsertFromStripe(stripeSub(customer, { plan: 'pro' }), 1);
    const later = await service.upsertFromStripe(
      stripeSub(customer, { plan: 'pro', status: 'canceled', cancelAtPeriodEnd: true }),
      2,
    );
    expect(later.view?.id).toBe(first.view?.id);
    expect(later.view).toMatchObject({
      plan: 'pro',
      status: 'canceled',
      seats: 1,
      cancel_at_period_end: true,
    });
  });

  it('stores a different currency as returned, plan unchanged, with a warning', async () => {
    const { service, captured, customer, ws, billing } = setup();
    await service.upsertFromStripe(stripeSub(customer), 1);
    const usd = stripeSub(customer, { currency: 'USD' });
    const result = await service.upsertFromStripe(usd, 2);
    expect(result.view).toMatchObject({ plan: 'team', currency: 'USD' });
    expect(billing.subscriptions.get(ws)?.currency).toBe('USD');
    const warning = captured.lines().find((l) => l['msg'] === 'billing.currency_changed');
    expect(warning).toMatchObject({ stored: 'EUR', returned: 'USD', workspace_id: ws });
  });

  it('keeps the stored plan for an unknown plan price, and refuses one for a new subscription', async () => {
    const { service, captured, customer } = setup();
    const unknown = (status = 'active') => {
      const sub = stripeSub(customer, { status });
      return { ...sub, items: sub.items.map((i) => ({ ...i, priceId: 'price_retired' })) };
    };
    await expect(service.upsertFromStripe(unknown(), 1)).rejects.toBeInstanceOf(BillingStateError);
    await service.upsertFromStripe(stripeSub(customer, { plan: 'team' }), 2);
    const kept = await service.upsertFromStripe(unknown(), 3);
    expect(kept.view?.plan).toBe('team');
    expect(captured.lines().some((l) => l['msg'] === 'billing.unknown_plan_price')).toBe(true);
  });

  it('refuses a subscription of a customer no workspace has', async () => {
    const { service } = setup();
    const error = await service
      .upsertFromStripe(stripeSub(stripeId('cus')), 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingStateError);
    expect((error as BillingStateError).reason).toBe('unknown_workspace');
  });

  it('shows no subscription for a status that maps to none', async () => {
    const { service, customer, ws } = setup();
    const result = await service.upsertFromStripe(stripeSub(customer, { status: 'incomplete' }), 1);
    expect(result.applied).toBe(true);
    expect(result.view).toBeNull();
    expect(await service.getSubscription(ws)).toBeNull();
  });
});

describe.runIf(ADMIN_URL !== undefined)('the stale guard on Postgres 16', () => {
  it('ignores an older event in the upsert and applies a newer one', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<BillingDb>;
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, ws, owner, 'owner');
      const repository = createBillingRepository(db);
      const customer = stripeId('cus');
      await repository.linkCustomer(ws, customer);
      const service = new BillingService({
        repository,
        gateway: new FakeStripe(),
        catalog: catalog(),
      });

      const sub = stripeSub(customer, { addonSeats: 1 });
      expect((await service.upsertFromStripe(sub, 5000)).view).toMatchObject({
        seats: 6,
        status: 'active',
      });
      const stale = await service.upsertFromStripe({ ...sub, status: 'canceled' }, 4999);
      expect(stale.applied).toBe(false);
      expect(stale.view?.status).toBe('active');
      const fresh = await service.upsertFromStripe({ ...sub, status: 'canceled' }, 5001);
      expect(fresh.applied).toBe(true);
      expect(fresh.view?.status).toBe('canceled');
      const row = await db.selectFrom('billing_subscription').selectAll().executeTakeFirstOrThrow();
      expect(Number(row.stripe_event_created)).toBe(5001);
      expect(row.stripe_subscription_id).toBe(sub.id);
      expect(row.id).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(await service.getSubscription(ws)).toEqual(fresh.view);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
