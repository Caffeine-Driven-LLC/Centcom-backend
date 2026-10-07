/**
 * `/v1/me` (B022 acceptance 1-8, card tests me.get, me.patch, scopes, active-workspace) over the
 * in-memory AccountStore: the response shapes against the contract schemas and pinned key sets,
 * ETag and If-Match (412, and one winner of two concurrent writers), validation by API field
 * name, unknown fields, telemetry, scopes and API keys, the 401 token errors, the active
 * workspace rules, the free-plan fallback, deleted and pending-deletion accounts, DB outages.
 */
import { validate } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { FREE_PLAN, withFreePlanFallback } from '../../src/modules/me/entitlements-lookup.js';
import { computeEtag } from '../../src/modules/me/etag.js';
import { addUser, as, meApp, memoryAccounts, newId, T0 } from './me-helpers.js';

const WORKSPACE = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

describe('GET /v1/me (card test me.get)', () => {
  it('answers 200 with the Me resource, an ETag and ent from the lookup (acceptance 1)', async () => {
    const store = memoryAccounts();
    const { user, version } = addUser(store);
    store.personal.set(user.id, WORKSPACE);
    store.memberships.add(`${user.id}|${WORKSPACE}`);
    const { app } = await meApp(store);
    const res = await app.inject({ url: '/v1/me', headers: as(user.id) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe(computeEtag({ version }));
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const body = res.json<Record<string, unknown>>();
    expect(validate('api/Me', body).ok).toBe(true);
    expect(body).toEqual({
      user: {
        id: user.id,
        email: user.email,
        display_name: 'Ada',
        locale: 'en',
        avatar: null,
        telemetry: false,
        created_at: new Date(T0).toISOString(),
        deletion_scheduled_for: null,
      },
      plan: 'pro',
      active_workspace: WORKSPACE,
      ent: 7,
    });
    await app.close();
  });

  it('pins the exact key sets: no tokens, secrets or other users’ data (acceptance 7)', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    addUser(store, { email: 'someone-else@example.test' });
    const { app } = await meApp(store);
    const res = await app.inject({ url: '/v1/me', headers: as(user.id) });
    const body = res.json<{ user: Record<string, unknown> }>();
    expect(Object.keys(body).sort()).toEqual(['active_workspace', 'ent', 'plan', 'user']);
    expect(Object.keys(body.user).sort()).toEqual([
      'avatar',
      'created_at',
      'deletion_scheduled_for',
      'display_name',
      'email',
      'id',
      'locale',
      'telemetry',
    ]);
    expect(res.body).not.toContain('someone-else@example.test');
    expect(res.body).not.toMatch(/token|secret|status/i);
    await app.close();
  });

  it('answers 401 with token_invalid or token_expired, and unauthorized without a token (acceptance 1)', async () => {
    const { app } = await meApp(memoryAccounts());
    for (const [token, code] of [
      ['invalid', 'token_invalid'],
      ['expired', 'token_expired'],
    ] as const) {
      const res = await app.inject({
        url: '/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code });
    }
    expect((await app.inject({ url: '/v1/me' })).json()).toMatchObject({ code: 'unauthorized' });
    await app.close();
  });

  it('answers 404 for a deleted account and shows a pending deletion (failure mode)', async () => {
    const store = memoryAccounts();
    const gone = addUser(store, { status: 'deleted' });
    const leaving = addUser(store, {
      status: 'pending_deletion',
      deletion_requested_at: new Date(T0),
    });
    const { app } = await meApp(store);
    expect((await app.inject({ url: '/v1/me', headers: as(gone.user.id) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/me', headers: as(newId('usr')) })).statusCode).toBe(404);
    const res = await app.inject({ url: '/v1/me', headers: as(leaving.user.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { deletion_scheduled_for: new Date(T0 + 30 * 86_400_000).toISOString() },
    });
    await app.close();
  });

  it('answers 200 with the free plan when entitlements are down, logging at most once a minute (failure mode)', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    const captured: Record<string, unknown>[] = [];
    let now = T0;
    const lookup = withFreePlanFallback(
      { forUser: () => Promise.reject(new Error('billing down')) },
      {
        logger: {
          warn: (fields: Record<string, unknown>, msg: string) => captured.push({ ...fields, msg }),
        } as never,
        now: () => now,
      },
    );
    const { app } = await meApp(store, { entitlements: lookup });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ url: '/v1/me', headers: as(user.id) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ plan: 'free', ent: 0 });
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['msg']).toMatch(/^entitlements_unavailable/);
    now += 60_000;
    await app.inject({ url: '/v1/me', headers: as(user.id) });
    expect(captured).toHaveLength(2);
    // An unusable answer falls back too.
    const odd = withFreePlanFallback({
      forUser: () => Promise.resolve({ plan: 'gold' as never, status: 'x', rev: -1 }),
    });
    expect(await odd.forUser(user.id)).toEqual(FREE_PLAN);
    await app.close();
  });

  it('answers 503 with retry_after_s when the database times out (failure mode)', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    store.failWith = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { app } = await meApp(store);
    const res = await app.inject({ url: '/v1/me', headers: as(user.id) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    store.failWith = new Error('a bug');
    expect((await app.inject({ url: '/v1/me', headers: as(user.id) })).statusCode).toBe(500);
    await app.close();
  });
});

describe('the active workspace (card test active-workspace)', () => {
  it('is the wsp claim while the user is a member, else the personal workspace, else null', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    const personal = newId('wsp');
    store.personal.set(user.id, personal);
    store.memberships.add(`${user.id}|${WORKSPACE}`);
    const { app } = await meApp(store);
    const active = async (wsp?: string): Promise<unknown> =>
      (
        await app.inject({
          url: '/v1/me',
          headers: as(user.id, wsp === undefined ? {} : { 'x-test-wsp': wsp }),
        })
      ).json<{
        active_workspace: unknown;
      }>().active_workspace;
    expect(await active(WORKSPACE)).toBe(WORKSPACE);
    // A claim for a workspace the user is not (or no longer) a member of is not trusted.
    expect(await active(newId('wsp'))).toBe(personal);
    store.memberships.delete(`${user.id}|${WORKSPACE}`);
    expect(await active(WORKSPACE)).toBe(personal);
    expect(await active()).toBe(personal);
    store.personal.delete(user.id);
    expect(await active(WORKSPACE)).toBeNull();
    await app.close();
  });
});

describe('PATCH /v1/me (card test me.patch)', () => {
  it('updates with a matching If-Match: 200, the User, a new ETag, one audit record (acceptance 2)', async () => {
    const store = memoryAccounts();
    const { user, version } = addUser(store);
    const { app, audit } = await meApp(store);
    const etag = computeEtag({ version });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id, { 'if-match': etag }),
      payload: { display_name: 'Ada L' },
    });
    expect(res.statusCode).toBe(200);
    expect(validate('api/User', res.json()).ok).toBe(true);
    expect(res.json()).toMatchObject({ id: user.id, display_name: 'Ada L' });
    expect(res.headers['etag']).toMatch(/^"v\d+"$/);
    expect(res.headers['etag']).not.toBe(etag);
    expect(audit.events).toEqual([
      {
        action: 'account.updated',
        userId: user.id,
        fields: ['display_name'],
        at: new Date(T0).toISOString(),
      },
    ]);
    await app.close();
  });

  it('refuses a stale ETag with 412 precondition_failed and changes nothing (acceptance 2)', async () => {
    const store = memoryAccounts();
    const { user, version } = addUser(store);
    const { app, audit } = await meApp(store);
    const stale = computeEtag({ version });
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id, { 'if-match': stale }),
      payload: { locale: 'fr' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id, { 'if-match': stale }),
      payload: { display_name: 'Lost' },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'precondition_failed' });
    expect(store.users.get(user.id)?.user).toMatchObject({ display_name: 'Ada', locale: 'fr' });
    expect(audit.events).toHaveLength(1);
    // A weak ETag never matches (strong comparison); * matches anything; no If-Match is unconditional.
    const weak = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id, { 'if-match': `W/${stale}` }),
      payload: { locale: 'de' },
    });
    expect(weak.statusCode).toBe(412);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(user.id, { 'if-match': '*' }),
          payload: { locale: 'de' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(user.id),
          payload: { locale: 'it' },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('lets exactly one of two concurrent PATCHes with the same If-Match win (acceptance 8)', async () => {
    const store = memoryAccounts();
    const { user, version } = addUser(store);
    const { app } = await meApp(store);
    const etag = computeEtag({ version });
    const results = await Promise.all(
      ['First', 'Second'].map((name) =>
        app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(user.id, { 'if-match': etag }),
          payload: { display_name: name },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    await app.close();
  });

  it.each([
    ['a 41-character name', { display_name: 'x'.repeat(41) }, '/display_name'],
    ['an empty name', { display_name: '' }, '/display_name'],
    ['control characters', { display_name: 'Ada\u0000' }, '/display_name'],
    ['an invalid locale', { locale: 'english' }, '/locale'],
    ['a non-string locale', { locale: 3 }, '/locale'],
    ['a 65-character avatar', { avatar: 'a'.repeat(65) }, '/avatar'],
    ['telemetry "yes"', { telemetry: 'yes' }, '/telemetry'],
  ])(
    'refuses %s with a validation problem at its pointer (acceptance 3, 4)',
    async (_label, payload, pointer) => {
      const store = memoryAccounts();
      const { user } = addUser(store);
      const { app, audit } = await meApp(store);
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: as(user.id),
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'validation_failed', errors: [{ pointer }] });
      expect(store.users.get(user.id)?.user.display_name).toBe('Ada');
      expect(audit.events).toEqual([]);
      await app.close();
    },
  );

  it('persists telemetry, avatars and canonical locales, under their API names (acceptance 4)', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    const { app } = await meApp(store);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id),
      payload: { telemetry: true, avatar: 'slot-3', locale: 'en-gb' },
    });
    expect(res.json()).toMatchObject({ telemetry: true, avatar: 'slot-3', locale: 'en-GB' });
    expect(store.users.get(user.id)?.user).toMatchObject({
      telemetry_opt_in: true,
      avatar_slot: 'slot-3',
      locale: 'en-GB',
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(user.id),
          payload: { avatar: null },
        })
      ).json(),
    ).toMatchObject({
      avatar: null,
    });
    await app.close();
  });

  it('ignores unknown fields (CT-VER) and never lets email, id or status through (acceptance 5)', async () => {
    const store = memoryAccounts();
    const { user, version } = addUser(store);
    const { app, audit } = await meApp(store);
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id),
      payload: { foo: 1 },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.headers['etag']).toBe(computeEtag({ version }));
    const sneaky = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id),
      payload: {
        email: 'evil@example.test',
        id: newId('usr'),
        status: 'deleted',
        display_name: 'Ada K',
      },
    });
    expect(sneaky.statusCode).toBe(200);
    expect(store.users.get(user.id)?.user).toMatchObject({
      id: user.id,
      email: user.email,
      status: 'active',
      display_name: 'Ada K',
    });
    expect(audit.events.map((e) => e.fields)).toEqual([['display_name']]);
    // An empty object names nothing (MeUpdate minProperties 1); a non-object is refused.
    expect(
      (await app.inject({ method: 'PATCH', url: '/v1/me', headers: as(user.id), payload: {} }))
        .statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: 'PATCH', url: '/v1/me', headers: as(user.id), payload: [1] }))
        .statusCode,
    ).toBe(422);
    // A no-op still honours If-Match.
    const stale = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: as(user.id, { 'if-match': computeEtag({ version }) }),
      payload: { foo: 1 },
    });
    expect(stale.statusCode).toBe(412);
    await app.close();
  });

  it('keeps the change when the audit sink fails, logging it', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    const { app, audit, lines } = await meApp(store);
    audit.fail = true;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(user.id),
          payload: { locale: 'fr' },
        })
      ).statusCode,
    ).toBe(200);
    expect(lines().some((l) => l['msg'] === 'me.audit_failed')).toBe(true);
    await app.close();
  });

  it('answers 404 for a deleted account', async () => {
    const store = memoryAccounts();
    const gone = addUser(store, { status: 'deleted' });
    const { app } = await meApp(store);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(gone.user.id),
          payload: { locale: 'fr' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: as(gone.user.id),
          payload: { foo: 1 },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe('scopes and principals (card test scopes)', () => {
  it('answers 403 without the profile scope on both routes, and to API keys (acceptance 6)', async () => {
    const store = memoryAccounts();
    const { user } = addUser(store);
    const { app } = await meApp(store);
    for (const method of ['GET', 'PATCH'] as const) {
      const scoped = await app.inject({
        method,
        url: '/v1/me',
        headers: as(user.id, { 'x-test-scopes': 'workspaces:read' }),
        payload: { locale: 'fr' },
      });
      expect(scoped.statusCode, method).toBe(403);
      expect(scoped.json()).toMatchObject({ code: 'forbidden' });
      const key = await app.inject({
        method,
        url: '/v1/me',
        headers: as(user.id, { 'x-test-kind': 'api_key' }),
        payload: { locale: 'fr' },
      });
      expect(key.statusCode, method).toBe(403);
    }
    expect(store.users.get(user.id)?.user.locale).toBe('en');
    await app.close();
  });

  it('reports the 401 a token gives before looking at the body', async () => {
    const store = memoryAccounts();
    const { app } = await meApp(store);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: 'Bearer expired' },
      payload: { display_name: '' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token_expired' });
    expect(new AppError('precondition_failed').status).toBe(412);
    await app.close();
  });
});
