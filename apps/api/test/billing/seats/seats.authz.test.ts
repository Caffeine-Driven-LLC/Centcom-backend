/**
 * Who may change seats (B073 acceptance 6, test plan "seats.authz.test.ts"): owner and billing
 * succeed; admin, member and guest get 403 `forbidden` (CT-RBAC "Change plan, payment method,
 * seats": owner and billing; B021 `billing.manage`); a member of another workspace, an unknown or a
 * malformed workspace gets 404; an API key needs `billing:write` and its own workspace; a token
 * without `billing:write` is 403; no credentials is 401. Refused callers reach no Stripe and the
 * preview follows the same rules.
 */
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { asKey, asUser, createWorkspace } from '../../modules/workspaces/helpers.js';
import { newId, patchSeats, WRITE, withTeam } from './helpers.js';

describe('PATCH /v1/workspaces/{id}/seats: authorization', () => {
  it('lets owner and billing change seats; refuses admin, member and guest with 403', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const expected: [WorkspaceRole, number][] = [
      ['owner', 200],
      ['billing', 200],
      ['admin', 403],
      ['member', 403],
      ['guest', 403],
    ];
    let seats = 6;
    for (const [role, status] of expected) {
      let user = ctx.owner;
      if (role !== 'owner') {
        user = newId('usr');
        ctx.store.join(ctx.ws, user, role);
      }
      const change = await patchSeats(ctx, ctx.ws, user, { seats });
      expect(change.statusCode, role).toBe(status);
      const preview = await patchSeats(
        ctx,
        ctx.ws,
        user,
        { seats: seats + 1 },
        { preview: 'true' },
      );
      expect(preview.statusCode, `${role} preview`).toBe(status);
      if (status === 403) expect(change.json<{ code: string }>().code, role).toBe('forbidden');
      seats += 1;
    }
    expect(ctx.stripe.writes()).toHaveLength(2);
    await ctx.app.close();
  });

  it('hides other workspaces (404), and checks scopes and API keys', async () => {
    const ctx = await withTeam();
    ctx.inUse.counts.set(ctx.ws, 5);
    const stranger = newId('usr');
    ctx.store.addUser(stranger);
    const theirs = (await createWorkspace(ctx.app, stranger, 'Theirs')).id;
    expect((await patchSeats(ctx, ctx.ws, stranger, { seats: 6 })).statusCode).toBe(404);
    expect((await patchSeats(ctx, theirs, ctx.owner, { seats: 6 })).statusCode).toBe(404);
    for (const id of [newId('wsp'), 'wsp_bad']) {
      expect((await patchSeats(ctx, id, ctx.owner, { seats: 6 })).statusCode, id).toBe(404);
    }
    const patch = (headers?: Record<string, string>) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${ctx.ws}/seats`,
        ...(headers === undefined ? {} : { headers }),
        payload: { seats: 6 },
      });
    expect((await patch(asUser(ctx.owner, 'billing:read'))).statusCode).toBe(403);
    expect((await patch(asKey(ctx.ws, 'billing:read'))).statusCode).toBe(403);
    expect((await patch(asKey(newId('wsp'), WRITE))).statusCode).toBe(404);
    expect((await patch()).statusCode).toBe(401);
    expect(ctx.stripe.calls).toHaveLength(0);
    expect((await patch(asKey(ctx.ws, WRITE))).statusCode).toBe(200);
    await ctx.app.close();
  });
});
