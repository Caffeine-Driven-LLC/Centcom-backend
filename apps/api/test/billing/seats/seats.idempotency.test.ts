/**
 * Idempotency of seat changes (B073 acceptance 5, test plan "seats.idempotency.test.ts",
 * guardrail "MUST send an idempotency key to Stripe derived from the request Idempotency-Key",
 * failure mode "Stripe accepted the update but the response was lost -> retry with same
 * idempotency key returns the same result"):
 *
 * - the same Idempotency-Key and body replay the stored response with `Idempotency-Replayed: true`
 *   (B024, which accepts this PATCH because the contract marks `changeSeats` idempotent) and make
 *   one Stripe update; the same key with another body is 409 `idempotency_conflict`, and so is a
 *   preview and the change sent with one key (the query is part of a PATCH's request);
 * - Stripe's idempotency key is derived from the caller, the request's key and the seats before
 *   and after (never the raw key), so two requests with different keys are two updates, and one
 *   request retried is one;
 * - Stripe applied the update but the answer was lost (503): the retry with the same key reads the
 *   subscription, finds the target already there and stores it without a second write (which would
 *   carry other parameters under the same Stripe key, and Stripe refuses that); it answers 200.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { patchSeats, withTeam } from './helpers.js';

const timeout = () =>
  new StripeError('unavailable', 'Stripe unavailable after 4 attempts (timed out)');

describe('PATCH /v1/workspaces/{id}/seats: idempotency', () => {
  it('replays the same key and body with one Stripe update; refuses the key with another body', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const key = randomUUID();
    const headers = { 'idempotency-key': key };
    const first = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers });
    expect(first.statusCode).toBe(200);
    const again = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.headers['cache-control']).toBe('no-store');
    expect(again.json()).toEqual(first.json());
    expect(ctx.stripe.writes()).toHaveLength(1);
    const stripeKey = ctx.stripe.writes()[0]?.key ?? '';
    expect(stripeKey).toMatch(new RegExp(`^centcom-${ctx.ws}-seats-5-8-[0-9a-f]{32}$`));
    expect(stripeKey).not.toContain(key);

    const other = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 9 }, { headers });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
    expect(ctx.stripe.writes()).toHaveLength(1);
    await ctx.app.close();
  });

  it('refuses a preview and the change sent with one key', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const headers = { 'idempotency-key': randomUUID() };
    const preview = await patchSeats(
      ctx,
      ctx.ws,
      ctx.owner,
      { seats: 8 },
      { preview: 'true', headers },
    );
    expect(preview.json()).toMatchObject({ seats: 8, preview: true });
    const change = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers });
    expect(change.statusCode).toBe(409);
    expect(change.json<{ code: string }>().code).toBe('idempotency_conflict');
    expect(ctx.stripe.writes()).toHaveLength(0);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(5);
    await ctx.app.close();
  });

  it('records a change Stripe applied though its answer was lost, on a retry with the key', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    ctx.stripe.lostAnswers.push(timeout());
    const headers = { 'idempotency-key': randomUUID() };
    const lost = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers });
    expect(lost.statusCode).toBe(503);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(5);
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(8);

    const retried = await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ seats: 8 });
    expect(ctx.stripe.writes()).toHaveLength(1);
    expect(ctx.stripe.calls.map((c) => c.kind)).toEqual(['retrieve', 'update', 'retrieve']);
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(8);
    expect(ctx.billing.subscriptions.get(ctx.ws)?.seats).toBe(8);
    await ctx.app.close();
  });

  it('sends the same Stripe key and parameters when a retry follows an update Stripe never got', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    ctx.stripe.failures.update = [timeout()];
    const headers = { 'idempotency-key': randomUUID() };
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers })).statusCode).toBe(
      503,
    );
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(5);
    expect((await patchSeats(ctx, ctx.ws, ctx.owner, { seats: 8 }, { headers })).statusCode).toBe(
      200,
    );
    const [first, second] = ctx.stripe.writes();
    expect(second?.key).toBe(first?.key);
    expect(second?.input).toEqual(first?.input);
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(8);
    await ctx.app.close();
  });

  it('makes two updates for two requests with different keys', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    await patchSeats(
      ctx,
      ctx.ws,
      ctx.owner,
      { seats: 8 },
      { headers: { 'idempotency-key': randomUUID() } },
    );
    await patchSeats(
      ctx,
      ctx.ws,
      ctx.owner,
      { seats: 9 },
      { headers: { 'idempotency-key': randomUUID() } },
    );
    expect(ctx.stripe.writes()).toHaveLength(2);
    expect(ctx.stripe.seats(ctx.sub.id)).toBe(9);
    await ctx.app.close();
  });
});
