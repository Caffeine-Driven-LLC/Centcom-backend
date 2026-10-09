/**
 * Reconciling seats with Stripe (B073 acceptance 7, scope "Reconciliation job
 * billing.seats.reconcile (daily) comparing Stripe quantity with the stored seats and seats in use,
 * repairing drift and logging mismatches", test plan "seats.reconcile.test.ts", failure mode
 * "Stripe accepted the update but the response was lost -> ... reconcile also heals"):
 *
 * - Stripe at 10 seats, stored 8: the stored seats and the entitlements follow Stripe, drift is
 *   reported and repaired; running again reports no drift;
 * - more seats in use than Stripe sells is logged (not changed on Stripe);
 * - a workspace not on Team in effect has nothing to reconcile;
 * - `reconcileAll` walks every Team workspace in batches by id, counts repairs, and goes on past
 *   one workspace's failure (counted and logged).
 */
import { describe, expect, it } from 'vitest';
import {
  RECONCILE_BATCH,
  reconcileAll,
  type ReconcileSource,
} from '../../../src/modules/billing/seats/reconcile.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { newId, SEAT_PRICE_ID, withTeam } from './helpers.js';

describe('SeatService.reconcile', () => {
  it('stores Stripe’s seats when they drifted, then finds nothing to do', async () => {
    const ctx = await withTeam({ addonSeats: 3 });
    ctx.inUse.counts.set(ctx.ws, 6);
    const item = ctx.stripe.subscriptions
      .get(ctx.sub.id)
      ?.items.find((i) => i.priceId === SEAT_PRICE_ID);
    if (item !== undefined) item.quantity = 5;
    const rev = ctx.entitlements.revs.get(ctx.ws) ?? 0;
    expect(await ctx.service.reconcile(ctx.ws)).toEqual({ drift: true, repaired: true });
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(10);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(rev + 1);
    expect(ctx.captured.lines().find((l) => l['msg'] === 'billing.seats_drift')).toMatchObject({
      stored_seats: 8,
      stripe_seats: 10,
    });
    expect(await ctx.service.reconcile(ctx.ws)).toEqual({ drift: false, repaired: false });
    expect(ctx.recorded.count('billing_seat_reconciles_total', { outcome: 'repaired' })).toBe(1);
    expect(ctx.recorded.count('billing_seat_reconciles_total', { outcome: 'in_sync' })).toBe(1);
    expect(ctx.stripe.writes()).toHaveLength(0);
    await ctx.app.close();
  });

  it('logs more seats in use than Stripe sells, and skips workspaces not on Team', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 7);
    expect(await ctx.service.reconcile(ctx.ws)).toEqual({ drift: false, repaired: false });
    expect(
      ctx.captured.lines().find((l) => l['msg'] === 'billing.seats_over_capacity'),
    ).toMatchObject({
      seats: 5,
      in_use: 7,
    });
    expect(ctx.stripe.writes()).toHaveLength(0);
    await ctx.app.close();

    const pro = await withTeam({ plan: 'pro' });
    expect(await pro.service.reconcile(pro.ws)).toEqual({ drift: false, repaired: false });
    expect(await pro.service.reconcile(newId('wsp'))).toEqual({ drift: false, repaired: false });
    expect(pro.stripe.calls).toHaveLength(0);
    await pro.app.close();
  });
});

describe('reconcileAll', () => {
  it('walks every Team workspace in batches and goes on past a failure', async () => {
    const ids = Array.from(
      { length: RECONCILE_BATCH + 3 },
      (_, i) => `wsp_${String(i).padStart(26, '0')}`,
    );
    const pages: (string | null)[] = [];
    const source: ReconcileSource = {
      teamWorkspaces: (after, limit) => {
        pages.push(after);
        const start = after === null ? 0 : ids.indexOf(after) + 1;
        return Promise.resolve(ids.slice(start, start + limit));
      },
    };
    const seen: string[] = [];
    const captured = captureLogger();
    const recorded = recordingMetrics();
    const run = await reconcileAll({
      source,
      logger: captured.logger,
      metrics: recorded.metrics,
      seats: {
        reconcile: (ws) => {
          seen.push(ws);
          if (ws === ids[5]) return Promise.reject(new StripeError('unavailable', 'down'));
          return Promise.resolve({ drift: ws === ids[7], repaired: ws === ids[7] });
        },
      },
    });
    expect(run).toEqual({ checked: ids.length - 1, repaired: 1, failed: 1 });
    expect(seen).toEqual(ids);
    expect(pages).toEqual([null, ids[RECONCILE_BATCH - 1]]);
    expect(recorded.count('billing_seat_reconciles_total', { outcome: 'failed' })).toBe(1);
    expect(captured.lines().filter((l) => l['msg'] === 'billing.seats_reconcile_failed')).toEqual([
      expect.objectContaining({ workspace_id: ids[5], error: 'StripeError' }),
    ]);
  });
});
