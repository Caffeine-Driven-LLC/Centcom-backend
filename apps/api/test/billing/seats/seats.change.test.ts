/**
 * Changing seats (B073 acceptance 2, 3 and 4, test plan "seats.change.test.ts: increase, decrease,
 * bounds", guardrails "MUST NOT reduce seats below members plus pending invites; check and Stripe
 * update MUST be serialised per workspace" and "MUST NOT apply a seat change locally before Stripe
 * accepts it", failure mode "invite accepted concurrently while decreasing seats"):
 *
 * - Team from 5 to 8: one Stripe write (after one read), the add-on seat item at quantity 3 with
 *   `create_prorations`; 200 `SeatChangeResult` `{seats: 8, preview: false}` (the contract's
 *   answer); the subscription state handed to B069 resolves to `max_seats` 8 (CT-ENTITLEMENTS)
 *   and entitlements' `rev` goes up by exactly 1; one audit event `billing.seats` (CT-API-AUDIT's
 *   name) from 5 to 8; the later webhook for the same subscription changes nothing more;
 * - later changes update that item (or remove it at 5); the same seats again changes nothing;
 * - below the seats in use (4 with 6 members): 409 `conflict` with `errors[0].code`
 *   `seats_in_use` and no Stripe call; below Team's included 5: 422; 501 (over the maximum), 1.5,
 *   a string or 0: 422 `validation_failed` at `/seats`;
 * - Pro, the free plan and a stored status `none`: 409 (`single_seat_plan`); a canceled
 *   subscription: 409 (`subscription_inactive`);
 * - an invite accepted while a decrease waits for the workspace's lock is counted: the decrease is
 *   refused, not applied below the members.
 */
import { validate } from '@centcom/contracts';
import { AUDIT_BATCH_INTERVAL_MS } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  PLAN_IDS,
  resolveEntitlements,
  SEED_PLANS,
  type PlanCatalog,
} from '../../../src/modules/entitlements/index.js';
import { patchSeats, SEAT_PRICE_ID, withTeam } from './helpers.js';

const plans: PlanCatalog = new Map(PLAN_IDS.map((id) => [id, SEED_PLANS[id].limits]));

describe('PATCH /v1/workspaces/{id}/seats', () => {
  it('adds 3 seats with one Stripe write, bumps rev once and audits the change', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const revBefore = ctx.entitlements.revs.get(ctx.ws) ?? 0;
    const response = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<Record<string, unknown>>();
    expect(validate('api/SeatChangeResult', body).ok).toBe(true);
    expect(body).toEqual({ seats: 8, preview: false, proration: null });

    const writes = ctx.stripe.writes();
    expect(writes).toHaveLength(1);
    expect(ctx.stripe.calls.map((c) => c.kind)).toEqual(['retrieve', 'update']);
    expect(writes[0]?.input).toEqual({
      subscriptionId: ctx.sub.id,
      items: [{ priceId: SEAT_PRICE_ID, quantity: 3 }],
      prorationBehavior: 'create_prorations',
    });
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(8);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(8);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(revBefore + 1);
    // max_seats as B069 derives it from the state it was handed (CT-ENTITLEMENTS: 5 plus add-ons).
    const state = ctx.entitlements.states.get(ctx.ws);
    expect(state).toMatchObject({ plan: 'team', status: 'active', addon_seats: 3 });
    if (state === undefined) throw new Error('no state');
    const resolved = resolveEntitlements(
      {
        plan: state.plan,
        status: state.status,
        period: state.period,
        grace_until: null,
        addonSeats: state.addon_seats,
        now: new Date(Date.UTC(2026, 9, 9, 12)),
      },
      plans,
    );
    expect(resolved.limits.max_seats).toBe(8);

    // The webhook Stripe sends for this update later: stored, and entitlements do not move again.
    const later = ctx.stripe.subscriptions.get(ctx.sub.id);
    if (later === undefined) throw new Error('no subscription');
    await ctx.billingService.upsertFromStripe(structuredClone(later), 10_000);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(8);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(revBefore + 1);

    await ctx.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(ctx.detached).toEqual([
      expect.objectContaining({ action: 'billing.seats', target_id: ctx.ws, actor_id: ctx.owner }),
    ]);
    expect(JSON.parse(String(ctx.detached[0]?.['meta']))).toEqual({ from_seats: 5, to_seats: 8 });
    await ctx.app.close();
  });

  it('updates the add-on item on later changes, removes it at 5, and leaves equal seats alone', async () => {
    const ctx = await withTeam({ addonSeats: 3 });
    ctx.inUse.counts.set(ctx.ws, 5);
    const itemId = ctx.sub.items.find((i) => i.priceId === SEAT_PRICE_ID)?.id;
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 10 })).json()).toMatchObject({
      seats: 10,
    });
    expect(ctx.stripe.writes()[0]?.input).toMatchObject({
      items: [{ id: itemId, priceId: SEAT_PRICE_ID, quantity: 5 }],
    });
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 6 })).json()).toMatchObject({
      seats: 6,
    });
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 5 })).json()).toMatchObject({
      seats: 5,
    });
    expect(ctx.stripe.writes()[2]?.input).toMatchObject({
      items: [{ id: itemId, deleted: true }],
    });
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(5);
    const writes = ctx.stripe.writes().length;
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 5 })).statusCode).toBe(200);
    expect(ctx.stripe.writes()).toHaveLength(writes);
    await ctx.app.close();
  });

  it('refuses fewer seats than are in use (409 seats_in_use, no Stripe call) and bad numbers (422)', async () => {
    const ctx = await withTeam({ addonSeats: 3 });
    ctx.inUse.counts.set(ctx.ws, 6);
    const below = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 4 });
    expect(below.statusCode).toBe(409);
    expect(below.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(below.json()).toMatchObject({
      code: 'conflict',
      errors: [{ pointer: '/seats', code: 'seats_in_use' }],
    });
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 5 })).json()).toMatchObject({
      errors: [{ code: 'seats_in_use' }],
    });
    expect(ctx.stripe.calls).toHaveLength(0);

    ctx.inUse.counts.set(ctx.ws, 2);
    const underIncluded = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 3 });
    expect(underIncluded.statusCode).toBe(422);
    expect(underIncluded.json()).toMatchObject({
      errors: [{ pointer: '/seats', code: 'out_of_range' }],
    });
    for (const seats of [501, 1.5, '8', 0, -1, null]) {
      const response = await patchSeats(ctx, ctx.ws, ctx.owner, { seats });
      expect(response.statusCode, JSON.stringify(seats)).toBe(422);
      expect(response.json<{ code: string }>().code).toBe('validation_failed');
    }
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, {})).statusCode).toBe(422);
    expect(ctx.stripe.calls).toHaveLength(0);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(8);
    await ctx.app.close();
  });

  it('answers 409 for Pro, the free plan, a canceled subscription and status none', async () => {
    const pro = await withTeam({ plan: 'pro' });
    const proAnswer = await patchSeats(pro, pro.ws, pro.owner, { seats: 6 });
    expect(proAnswer.statusCode).toBe(409);
    expect(proAnswer.json()).toMatchObject({ errors: [{ code: 'single_seat_plan' }] });
    await pro.app.close();

    const free = await withTeam();
    free.billing.subscriptions.delete(free.ws);
    expect((await patchSeats(free, free.ws, free.owner, { seats: 6 })).json()).toMatchObject({
      code: 'conflict',
      errors: [{ code: 'single_seat_plan' }],
    });
    await free.app.close();

    const canceled = await withTeam({ status: 'canceled' });
    const answer = await patchSeats(canceled, canceled.ws, canceled.owner, { seats: 6 });
    expect(answer.statusCode).toBe(409);
    expect(answer.json()).toMatchObject({ errors: [{ code: 'subscription_inactive' }] });
    expect(canceled.stripe.calls).toHaveLength(0);
    await canceled.app.close();

    const none = await withTeam();
    const row = none.billing.subscriptions.get(none.ws);
    if (row !== undefined) none.billing.subscriptions.set(none.ws, { ...row, status: 'none' });
    const noneAnswer = await patchSeats(none, none.ws, none.owner, { seats: 6 });
    expect(noneAnswer.statusCode).toBe(409);
    expect(noneAnswer.json()).toMatchObject({ errors: [{ code: 'single_seat_plan' }] });
    expect(none.stripe.calls).toHaveLength(0);
    await none.app.close();
  });

  it('counts an invite accepted while the decrease waits for the lock', async () => {
    const ctx = await withTeam({ addonSeats: 3 });
    ctx.inUse.counts.set(ctx.ws, 6);
    // An invite holds the workspace's lock and adds the seventh member.
    let release = (): void => undefined;
    const invite = ctx.locks.lock.withWorkspaceLock(ctx.ws, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      ctx.inUse.counts.set(ctx.ws, 7);
    });
    const decrease = patchSeats(ctx, ctx.ws, ctx.owner, { seats: 6 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.stripe.writes()).toHaveLength(0);
    release();
    await invite;
    const answer = await decrease;
    expect(answer.statusCode).toBe(409);
    expect(answer.json()).toMatchObject({ errors: [{ code: 'seats_in_use' }] });
    expect(ctx.stripe.writes()).toHaveLength(0);
    expect(ctx.locks.held).toEqual([ctx.ws, ctx.ws]);
    await ctx.app.close();
  });
});
