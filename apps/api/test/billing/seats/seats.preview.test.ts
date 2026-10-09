/**
 * The proration preview (B073 acceptance 1, test plan "seats.preview.test.ts: no side effects",
 * guardrails "Preview MUST NOT mutate Stripe or DB state" and "Money MUST be integer minor
 * units"):
 *
 * - `?preview=true` answers the contract's `SeatChangeResult` with `preview: true` and the
 *   proration as `Money` (the sum of Stripe's proration lines for this change, integer minor
 *   units, in the subscription's currency) and when it takes effect; Stripe is asked to prorate
 *   from now (`prorationDate`), and an earlier change's proration still pending on the upcoming
 *   invoice is not counted;
 * - it makes no Stripe write (only a read and the invoice preview) and leaves the stored
 *   subscription, entitlements' `rev` and the audit log unchanged;
 * - it is bounded like a change (seats in use; Pro and canceled are 409 with no Stripe call);
 *   `preview=false` is a change; any other value of `preview` is 422 at `/preview`;
 * - the answer is `Cache-Control: no-store`.
 */
import { validate } from '@centcom/contracts';
import { AUDIT_BATCH_INTERVAL_MS } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { patchSeats, SEAT_PRICE, withTeam } from './helpers.js';

describe('PATCH /v1/workspaces/{id}/seats?preview=true', () => {
  it('answers the proration as Money with no write anywhere', async () => {
    const ctx = await withTeam({ addonSeats: 2 });
    ctx.inUse.counts.set(ctx.ws, 5);
    const stored = structuredClone(ctx.billing.subscriptions.get(ctx.ws));
    const rev = ctx.entitlements.revs.get(ctx.ws);
    const response = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 10 }, { preview: 'true' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<Record<string, unknown>>();
    expect(validate('api/SeatChangeResult', body).ok).toBe(true);
    expect(body).toEqual({
      seats: 10,
      preview: true,
      proration: {
        amount: { amount: 3 * (SEAT_PRICE / 2), currency: 'EUR' },
        effective_at: '2026-10-09T12:00:00.000Z',
      },
    });
    expect(
      Number.isInteger((body['proration'] as { amount: { amount: number } }).amount.amount),
    ).toBe(true);
    expect(ctx.stripe.writes()).toHaveLength(0);
    expect(ctx.stripe.calls.map((c) => c.kind)).toEqual(['retrieve', 'preview']);
    expect(ctx.stripe.calls[1]?.input).toMatchObject({
      customerId: ctx.customer,
      subscriptionId: ctx.sub.id,
      items: [{ quantity: 5 }],
      prorationDate: Date.UTC(2026, 9, 9, 12) / 1000,
    });
    expect(ctx.billing.subscriptions.get(ctx.ws)).toEqual(stored);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(rev);
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(7);
    await ctx.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(ctx.detached).toEqual([]);
    await ctx.app.close();
  });

  it('previews a decrease as a negative proration, and the same seats as none', async () => {
    const ctx = await withTeam({ addonSeats: 4 });
    ctx.inUse.counts.set(ctx.ws, 5);
    // An earlier change's proration, still on the upcoming invoice, is not this change's.
    ctx.stripe.pendingProration = 1234;
    const down = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 6 }, { preview: 'true' });
    expect(down.json()).toMatchObject({
      proration: { amount: { amount: -3 * (SEAT_PRICE / 2), currency: 'EUR' } },
    });
    const same = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 9 }, { preview: 'true' });
    expect(same.json()).toMatchObject({ seats: 9, preview: true });
    expect(ctx.stripe.writes()).toHaveLength(0);
    await ctx.app.close();
  });

  it('is bounded like a change, and takes preview=true or false only', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 7);
    const below = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 6 }, { preview: 'true' });
    expect(below.statusCode).toBe(409);
    expect(ctx.stripe.calls).toHaveLength(0);
    const odd = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 9 }, { preview: 'yes' });
    expect(odd.statusCode).toBe(422);
    expect(odd.json()).toMatchObject({ errors: [{ pointer: '/preview' }] });
    const change = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 9 }, { preview: 'false' });
    expect(change.json()).toEqual({ seats: 9, preview: false, proration: null });
    expect(ctx.stripe.writes()).toHaveLength(1);
    await ctx.app.close();

    for (const options of [{ plan: 'pro' as const }, { status: 'canceled' }]) {
      const other = await withTeam(options);
      const refused = await patchSeats(
        other,
        other.ws,
        other.owner,
        { seats: 6 },
        { preview: 'true' },
      );
      expect(refused.statusCode, JSON.stringify(options)).toBe(409);
      expect(other.stripe.calls).toHaveLength(0);
      await other.app.close();
    }
  });
});
