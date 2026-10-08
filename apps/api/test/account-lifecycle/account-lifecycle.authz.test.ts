/**
 * Who may use the account lifecycle routes (B026; tests "account-lifecycle.authz.test.ts"): no
 * credential is 401; an API key (a machine principal, not a user) is 403 on every route, DELETE
 * /v1/me and POST /v1/me/export included; a user token without `profile` is 403. Nothing changes
 * for a refused request.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { bearer, lifecycleApp } from './helpers.js';

const ROUTES = [
  { method: 'DELETE', url: '/v1/me' },
  { method: 'POST', url: '/v1/me/restore' },
  { method: 'POST', url: '/v1/me/export' },
  { method: 'GET', url: `/v1/me/export/${newId('exp')}` },
] as const;

describe('account lifecycle authorisation', () => {
  it('answers 401 without a credential', async () => {
    const h = await lifecycleApp();
    for (const route of ROUTES) {
      const res = await h.app.inject(route);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.json()).toMatchObject({ code: 'unauthorized' });
    }
    await h.app.close();
  });

  it('refuses API keys: machine principals are not users', async () => {
    const h = await lifecycleApp();
    for (const route of ROUTES) {
      const res = await h.app.inject({
        ...route,
        headers: bearer(`cen_live_${'k'.repeat(32)}`),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(h.store.exports.size).toBe(0);
    expect(h.jobs.calls.purges).toEqual([]);
    await h.app.close();
  });

  it('refuses a user token without the profile scope', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId, ['sessions:read']);
    for (const route of ROUTES) {
      const res = await h.app.inject({ ...route, headers: bearer(tokens.access_token) });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
    expect(h.store.users.get(user.id)?.status).toBe('active');
    await h.app.close();
  });
});
