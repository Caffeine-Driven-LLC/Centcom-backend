/**
 * Failures (B073 acceptance 8, test plan "seats.failure.test.ts: Stripe errors", failure mode "B030
 * port unavailable -> fail closed (503), never assume zero seats in use"):
 *
 * - Stripe unreachable when updating or reading the subscription: 503 with `retry_after_s` and
 *   `Retry-After`; the stored seats, entitlements' `rev` and the audit log are unchanged (nothing is
 *   applied locally before Stripe accepted it);
 * - Stripe refusing the update: 500, nothing changed;
 * - B030's seat count unavailable: 503, no Stripe call (never assumed zero);
 * - billing off (no Stripe key): 503;
 * - the workspace's seat lock staying taken: 503 with `Retry-After: 1`; the database behind the
 *   lock unreachable: 503 too, naming no host.
 */
import { AUDIT_BATCH_INTERVAL_MS, isAppError, unavailable } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { createSeatLock } from '../../../src/modules/billing/seats/ports.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { patchSeats, withTeam } from './helpers.js';

describe('PATCH /v1/workspaces/{id}/seats: failures', () => {
  it('answers 503 with retry_after_s when Stripe is unreachable, changing nothing', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const rev = ctx.entitlements.revs.get(ctx.ws);
    ctx.stripe.failures.update = [new StripeError('unavailable', 'down')];
    const failed = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 });
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(Number(failed.headers['retry-after'])).toBe(30);
    expect(failed.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 30 });
    ctx.stripe.failures.retrieve = [new StripeError('unavailable', 'down')];
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 })).statusCode).toBe(503);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(5);
    expect(ctx.entitlements.revs.get(ctx.ws)).toBe(rev);
    await ctx.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(ctx.detached).toEqual([]);
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 })).statusCode).toBe(200);
    await ctx.app.close();
  });

  it('answers 500 when Stripe refuses, changing nothing', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    ctx.stripe.failures.update = [
      new StripeError('request', 'No such price', 400, 'resource_missing'),
    ];
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 })).statusCode).toBe(500);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(5);
    expect(ctx.captured.lines().some((l) => l['msg'] === 'billing.seats_stripe_failed')).toBe(true);
    await ctx.app.close();
  });

  it('fails closed when the seat count is unavailable, and with billing off', async () => {
    const ctx = await withTeam();
    ctx.inUse.fail(true);
    const down = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 });
    expect(down.statusCode).toBe(503);
    expect(ctx.stripe.calls).toHaveLength(0);
    expect(
      (await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { preview: 'true' })).statusCode,
    ).toBe(503);
    await ctx.app.close();

    const off = await withTeam({ billingOff: true });
    off.inUse.counts.set(off.ws, 5);
    expect((await patchSeats(off, off.ws, off.owner, { seats: 8 })).statusCode).toBe(503);
    await off.app.close();
  });

  it('answers 503 with Retry-After 1 when the seat lock stays taken', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    ctx.locks.lock.withWorkspaceLock = () => Promise.reject(unavailable(1, 'busy'));
    const busy = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    expect(ctx.stripe.calls).toHaveLength(0);
    await ctx.app.close();
  });

  it('answers 503 naming no host when the database behind the lock cannot be reached', async () => {
    const down = new Error('connect ECONNREFUSED db.internal:5432');
    const lock = createSeatLock({
      connection: () => ({ execute: () => Promise.reject(down) }),
    } as never);
    let ran = false;
    const err = await lock
      .withWorkspaceLock('wsp_x', () => {
        ran = true;
        return Promise.resolve();
      })
      .catch((e: unknown) => e);
    expect(isAppError(err) && err.status).toBe(503);
    expect(isAppError(err) && err.retryAfterS).toBe(1);
    expect(String((err as Error).cause)).not.toContain('db.internal');
    expect(ran).toBe(false);
  });
});
