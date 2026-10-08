/**
 * Who may open checkout and portal sessions (B071 acceptance 2): the owner and billing members
 * (by roles from the membership store, never a claim) get their session; admins, members and
 * guests 403 `forbidden`; anyone else 404. Both need `billing:write`: a token with `billing:read`
 * only is 403. An API key needs `billing:write` and its own workspace.
 */
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { asKey } from '../../modules/workspaces/helpers.js';
import { caller, checkoutApp, newId, stripeId, teamCheckout, WRITE } from './helpers.js';

const ROLES: [WorkspaceRole, number][] = [
  ['billing', 0],
  ['admin', 403],
  ['member', 403],
  ['guest', 403],
];

describe('checkout and portal: role × scope', () => {
  it('lets the owner and billing members check out (201); admins, members and guests get 403, outsiders 404', async () => {
    const { app, store, owner, ws, stripe } = await checkoutApp();
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers,
        payload: teamCheckout(),
      });
    expect((await post(caller(owner))).statusCode).toBe(201);
    for (const [role, refused] of ROLES) {
      const user = newId('usr');
      store.join(ws, user, role);
      const res = await post(caller(user));
      if (refused === 0) {
        expect(res.statusCode, role).toBe(201);
      } else {
        expect(res.statusCode, role).toBe(refused);
        expect(res.json<{ code: string }>().code).toBe('forbidden');
      }
    }
    const outsider = await post(caller(newId('usr')));
    expect(outsider.statusCode).toBe(404);
    // A role claim in the request changes nothing.
    const member = newId('usr');
    store.join(ws, member, 'member');
    expect((await post({ ...caller(member), 'x-test-role': 'owner' })).statusCode).toBe(403);
    // Refused callers never reached Stripe: two sessions (owner, billing member).
    expect(stripe.checkouts).toHaveLength(2);
    await app.close();
  });

  it('lets the owner and billing members open the portal (200); admins, members and guests get 403, outsiders 404', async () => {
    const { app, store, owner, ws, billing, stripe } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/v1/workspaces/${ws}/portal`, headers, payload: {} });
    expect((await post(caller(owner))).statusCode).toBe(200);
    for (const [role, refused] of ROLES) {
      const user = newId('usr');
      store.join(ws, user, role);
      expect((await post(caller(user))).statusCode, role).toBe(refused === 0 ? 200 : refused);
    }
    expect((await post(caller(newId('usr')))).statusCode).toBe(404);
    expect(stripe.portals).toHaveLength(2);
    await app.close();
  });

  it('needs billing:write: a token with billing:read only is 403, on both endpoints', async () => {
    const { app, owner, ws, billing } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    for (const path of ['checkout', 'portal']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/${path}`,
        headers: caller(owner, 'billing:read workspaces:read'),
        payload: path === 'checkout' ? teamCheckout() : {},
      });
      expect(res.statusCode, path).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('forbidden');
    }
    await app.close();
  });

  it('takes an API key with billing:write of the workspace itself, and no other', async () => {
    const { app, ws } = await checkoutApp();
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: teamCheckout(),
      });
    expect((await post(asKey(ws, WRITE))).statusCode).toBe(201);
    expect((await post(asKey(ws, 'billing:read'))).statusCode).toBe(403);
    expect((await post(asKey(newId('wsp'), WRITE))).statusCode).toBe(404);
    await app.close();
  });
});
