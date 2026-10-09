/**
 * Who may redeem (B079 acceptance 4, test plan "authz matrix across workspace roles"): owner and
 * billing redeem (B021 RBAC `billing.manage`, CT-RBAC "Change plan, payment method, seats": owner
 * and billing; openapi's `x-role: owner/billing`); admin, member and guest get 403 `forbidden`
 * (B021 audits the refusal); a member of another workspace, an unknown or a malformed workspace
 * gets 404; an API key needs `billing:write` and its own workspace; a token without
 * `billing:write` is 403; no credentials is 401. None of the refused callers reaches Stripe or
 * counts an attempt.
 */
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { asKey, asUser, createWorkspace } from '../../modules/workspaces/helpers.js';
import { newCode, newId, promotionCode, redeemAs, WRITE, withSubscription } from './helpers.js';

describe('POST /v1/workspaces/{id}/coupons/redeem: authorization', () => {
  it('lets owner and billing redeem; refuses admin, member and guest with 403', async () => {
    const ctx = await withSubscription();
    const expected: [WorkspaceRole, number][] = [
      ['owner', 200],
      ['billing', 200],
      ['admin', 403],
      ['member', 403],
      ['guest', 403],
    ];
    for (const [role, status] of expected) {
      let user = ctx.owner;
      if (role !== 'owner') {
        user = newId('usr');
        ctx.store.join(ctx.ws, user, role);
      }
      const code = newCode();
      ctx.stripe.codes.push(promotionCode(code));
      const response = await redeemAs(ctx, ctx.ws, user, { code });
      expect(response.statusCode, role).toBe(status);
      if (status === 403) expect(response.json<{ code: string }>().code, role).toBe('forbidden');
    }
    expect(ctx.stripe.calls.filter((c) => c.kind === 'apply')).toHaveLength(2);
    await ctx.app.close();
  });

  it('hides other workspaces (404), and checks scopes and API keys', async () => {
    const ctx = await withSubscription();
    const stranger = newId('usr');
    ctx.store.addUser(stranger);
    const theirs = (await createWorkspace(ctx.app, stranger, 'Theirs')).id;
    const code = newCode();
    ctx.stripe.codes.push(promotionCode(code));
    expect((await redeemAs(ctx, ctx.ws, stranger, { code })).statusCode).toBe(404);
    expect((await redeemAs(ctx, theirs, ctx.owner, { code })).statusCode).toBe(404);
    for (const id of [newId('wsp'), 'wsp_bad']) {
      expect((await redeemAs(ctx, id, ctx.owner, { code })).statusCode, id).toBe(404);
    }
    const post = (headers?: Record<string, string>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ctx.ws}/coupons/redeem`,
        ...(headers === undefined ? {} : { headers }),
        payload: { code },
      });
    expect((await post(asUser(ctx.owner, 'billing:read'))).statusCode).toBe(403);
    expect((await post(asKey(ctx.ws, 'billing:read'))).statusCode).toBe(403);
    expect((await post(asKey(newId('wsp'), WRITE))).statusCode).toBe(404);
    expect((await post()).statusCode).toBe(401);
    expect(ctx.stripe.calls).toHaveLength(0);
    expect((await post(asKey(ctx.ws, WRITE))).statusCode).toBe(200);
    await ctx.app.close();
  });
});
