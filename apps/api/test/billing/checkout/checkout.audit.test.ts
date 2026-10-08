/**
 * Audit and logs (B071 acceptance 8, guardrail "never log the Stripe URL or session id"): each
 * endpoint writes one audit event (`billing.checkout`, `billing.portal`: CT-API-AUDIT's stable
 * names) with the actor, the workspace and the plan (and, for checkout, interval and seats); no
 * URL and no Stripe id in the audit payload or the logs; a replay writes no second event; a
 * refused caller is audited as RBAC's `permission.denied` only.
 */
import { AUDIT_BATCH_INTERVAL_MS } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { caller, checkoutApp, newId, stripeId, teamCheckout } from './helpers.js';

describe('checkout and portal audit', () => {
  it('writes one billing.checkout event with actor, workspace, plan, interval and seats', async () => {
    const { app, owner, ws, emitter, detached } = await checkoutApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout({ seats: 8 }),
    });
    expect(res.statusCode).toBe(201);
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    const events = detached.filter((r) => String(r['action']).startsWith('billing.'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'billing.checkout',
      outcome: 'success',
      actor_type: 'user',
      actor_id: owner,
      workspace_id: ws,
      target_type: 'workspace',
      target_id: ws,
    });
    expect(JSON.parse(String(events[0]?.['meta']))).toEqual({
      plan: 'team',
      interval: 'month',
      seats: 8,
    });
    await app.close();
  });

  it('writes one billing.portal event with the plan', async () => {
    const { app, owner, ws, billing, emitter, detached } = await checkoutApp();
    billing.customers.set(ws, stripeId('cus'));
    await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: {},
    });
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    const events = detached.filter((r) => String(r['action']).startsWith('billing.'));
    expect(events.map((r) => [r['action'], r['actor_id'], r['workspace_id']])).toEqual([
      ['billing.portal', owner, ws],
    ]);
    expect(JSON.parse(String(events[0]?.['meta']))).toEqual({ plan: 'free' });
    await app.close();
  });

  it('keeps URLs and Stripe ids out of the audit payload and the logs', async () => {
    const { app, owner, ws, billing, stripe, emitter, detached, captured } = await checkoutApp();
    const checkout = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(owner),
      payload: teamCheckout(),
    });
    const portal = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/portal`,
      headers: caller(owner),
      payload: {},
    });
    expect([checkout.statusCode, portal.statusCode]).toEqual([201, 200]);
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    const secrets = [
      checkout.json<{ url: string }>().url,
      portal.json<{ url: string }>().url,
      String(billing.customers.get(ws)),
      ...stripe.checkouts.map((c) => c.key),
    ];
    const audit = JSON.stringify(detached);
    const logs = captured.raw();
    for (const secret of secrets) {
      expect(audit).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(audit).not.toMatch(/https?:\/\//);
    expect(audit).not.toMatch(/\b(cs|cus|bps)_[A-Za-z0-9]/);
    await app.close();
  });

  it('writes no second event for a replayed request', async () => {
    const { app, owner, ws, emitter, detached } = await checkoutApp();
    const headers = caller(owner);
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/checkout`,
        headers,
        payload: teamCheckout(),
      });
    }
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(detached.filter((r) => r['action'] === 'billing.checkout')).toHaveLength(1);
    await app.close();
  });

  it('audits a refused caller as permission.denied only, with no billing event', async () => {
    const { app, store, ws, emitter, detached } = await checkoutApp();
    const member = newId('usr');
    store.join(ws, member, 'member');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/checkout`,
      headers: caller(member),
      payload: teamCheckout(),
    });
    expect(res.statusCode).toBe(403);
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(detached.map((r) => [r['action'], r['outcome'], r['actor_id']])).toEqual([
      ['permission.denied', 'denied', member],
    ]);
    await app.close();
  });
});
