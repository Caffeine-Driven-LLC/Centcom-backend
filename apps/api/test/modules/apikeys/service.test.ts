/**
 * API-key rules (B019 acceptance 4-6, guardrails; card test service.test.ts): scopes are known,
 * never `admin` and never beyond the creator's own rights; the workspace limit holds under
 * concurrent creates and counts only live keys; who sees and revokes which keys; and rotation is
 * all or nothing. Through the routes on B027's stack, callers named by headers.
 */
import { describe, expect, it } from 'vitest';
import { apiKeysApp, arrangeWorkspace, asKey, asUser, auditActions } from './helpers.js';

type App = Awaited<ReturnType<typeof apiKeysApp>>;

const create = (
  t: App,
  userId: string,
  body: Record<string, unknown>,
  scopes = 'workspaces:read workspaces:write billing:read webhooks:write audit:read usage:write',
) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: asUser(userId, scopes),
    payload: body,
  });

const keyBody = (workspace: string, overrides: Record<string, unknown> = {}) => ({
  workspace,
  name: 'CI',
  scopes: ['workspaces:read'],
  ...overrides,
});

describe('scopes (acceptance 4, guardrails)', () => {
  it.each([
    [['admin'], '/scopes/0'],
    [['workspaces:read', 'admin'], '/scopes/1'],
    [['sessions:everything'], '/scopes/0'],
  ])('refuses %j with 400 invalid_scope pointing at %s', async (scopes, pointer) => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const res = await create(t, users.owner, keyBody(workspaceId, { scopes }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_scope', errors: [{ pointer }] });
    expect(t.keys.keys.size).toBe(0);
  });

  it('refuses a scope the creator’s own credential does not hold', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const res = await create(
      t,
      users.owner,
      keyBody(workspaceId, { scopes: ['workspaces:read', 'audit:read'] }),
      'workspaces:read workspaces:write',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_scope', errors: [{ pointer: '/scopes/1' }] });
  });

  it.each([
    ['member', ['webhooks:write'], 400],
    ['member', ['workspaces:write'], 400],
    ['member', ['audit:read'], 400],
    ['member', ['billing:read'], 400],
    ['member', ['workspaces:read', 'usage:write'], 201],
    ['admin', ['webhooks:write', 'audit:read', 'workspaces:write', 'billing:read'], 201],
    ['owner', ['webhooks:write', 'audit:read', 'workspaces:write', 'billing:read'], 201],
  ] as const)(
    'a %s asking for %j gets %i: never beyond their role',
    async (role, scopes, status) => {
      const t = await apiKeysApp({ limit: null });
      const { workspaceId, users } = arrangeWorkspace(t.store);
      const res = await create(t, users[role], keyBody(workspaceId, { scopes: [...scopes] }));
      expect(res.statusCode, res.body).toBe(status);
      if (status === 400) expect(res.json()).toMatchObject({ code: 'invalid_scope' });
    },
  );

  it('an API key cannot create keys (403)', async () => {
    const t = await apiKeysApp();
    const { workspaceId } = arrangeWorkspace(t.store);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: asKey(workspaceId),
      payload: keyBody(workspaceId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });
});

describe('the workspace limit (acceptance 5, failure mode)', () => {
  it('refuses the 6th key at api_keys_max 5 with 429 quota_exceeded, creating nothing', async () => {
    const t = await apiKeysApp({ limit: 5 });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    for (let i = 0; i < 5; i++) {
      expect(
        (await create(t, users.owner, keyBody(workspaceId, { name: `k${i}` }))).statusCode,
      ).toBe(201);
    }
    const sixth = await create(t, users.owner, keyBody(workspaceId, { name: 'k5' }));
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({
      code: 'quota_exceeded',
      retry_after_s: expect.any(Number),
    });
    expect(t.keys.keys.size).toBe(5);
    expect(auditActions(t.store).filter((a) => a === 'api_key.create')).toHaveLength(5);
  });

  it('counts only live keys: a revoked or expired one frees its place', async () => {
    let now = Date.parse('2026-10-07T12:00:00Z');
    const t = await apiKeysApp({ limit: 2, clock: () => now });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const a = await create(t, users.owner, keyBody(workspaceId));
    await create(t, users.owner, keyBody(workspaceId, { expires_at: '2026-10-07T13:00:00Z' }));
    expect((await create(t, users.owner, keyBody(workspaceId))).statusCode).toBe(429);
    await t.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${String(a.json().id)}`,
      headers: asUser(users.owner),
    });
    expect((await create(t, users.owner, keyBody(workspaceId))).statusCode).toBe(201);
    expect((await create(t, users.owner, keyBody(workspaceId))).statusCode).toBe(429);
    now += 60 * 60 * 1000;
    expect((await create(t, users.owner, keyBody(workspaceId))).statusCode).toBe(201);
  });

  it('treats a null limit as unlimited', async () => {
    const t = await apiKeysApp({ limit: null });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    for (let i = 0; i < 25; i++) {
      expect((await create(t, users.owner, keyBody(workspaceId))).statusCode).toBe(201);
    }
  });

  it('is never passed by concurrent creates', async () => {
    const t = await apiKeysApp({ limit: 5 });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => create(t, users.owner, keyBody(workspaceId))),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(15);
    expect(t.keys.keys.size).toBe(5);
  });
});

describe('who sees and revokes which keys (acceptance 6)', () => {
  async function arranged() {
    const t = await apiKeysApp({ limit: null });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const ids: Record<string, string> = {};
    for (const role of ['owner', 'admin', 'member'] as const) {
      const res = await create(t, users[role], keyBody(workspaceId, { name: role }));
      ids[role] = String(res.json().id);
    }
    const other = arrangeWorkspace(t.store);
    return { t, workspaceId, users, ids, other };
  }
  const listed = async (t: App, userId: string, workspace?: string) => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys${workspace === undefined ? '' : `?workspace=${workspace}`}`,
      headers: asUser(userId),
    });
    return {
      status: res.statusCode,
      names:
        res.statusCode === 200
          ? (res.json().data as { name: string }[]).map((k) => k.name).sort()
          : [],
    };
  };

  it('an owner or admin sees every key of the workspace; a member their own', async () => {
    const { t, workspaceId, users } = await arranged();
    expect(await listed(t, users.owner, workspaceId)).toEqual({
      status: 200,
      names: ['admin', 'member', 'owner'],
    });
    expect(await listed(t, users.admin, workspaceId)).toEqual({
      status: 200,
      names: ['admin', 'member', 'owner'],
    });
    expect(await listed(t, users.member, workspaceId)).toEqual({ status: 200, names: ['member'] });
    expect(await listed(t, users.member)).toEqual({ status: 200, names: ['member'] });
  });

  it('billing and guest members get 403; members of another workspace 404', async () => {
    const { t, workspaceId, users, other } = await arranged();
    expect((await listed(t, users.billing, workspaceId)).status).toBe(403);
    expect((await listed(t, users.guest, workspaceId)).status).toBe(403);
    expect((await listed(t, other.users.owner, workspaceId)).status).toBe(404);
  });

  it('a member revokes their own key but not another’s (403); outsiders get 404', async () => {
    const { t, users, ids, other } = await arranged();
    const del = (userId: string, id: string) =>
      t.app.inject({ method: 'DELETE', url: `/v1/api-keys/${id}`, headers: asUser(userId) });
    expect((await del(users.member, String(ids['owner']))).statusCode).toBe(403);
    expect((await del(other.users.owner, String(ids['member']))).statusCode).toBe(404);
    expect((await del(users.member, String(ids['member']))).statusCode).toBe(204);
    expect((await del(users.admin, String(ids['owner']))).statusCode).toBe(204);
    // Revoking again is fine and audits nothing new.
    expect((await del(users.admin, String(ids['owner']))).statusCode).toBe(204);
    expect(auditActions(t.store).filter((a) => a === 'api_key.revoke')).toHaveLength(2);
  });
});

describe('rotateApiKey (guardrail: audited, atomic)', () => {
  it('makes a replacement with the same name, scopes and creator and revokes the old key', async () => {
    const t = await apiKeysApp({ limit: 1 });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const created = await create(
      t,
      users.member,
      keyBody(workspaceId, { scopes: ['workspaces:read', 'usage:write'], mode: 'test' }),
    );
    const oldId = String(created.json().id);
    const staff = { type: 'system' as const, id: 'admin-console' };
    const rotated = await t.apiKeys.rotateApiKey(oldId, staff, {
      audit: (trx, input) => t.emitter.emit(trx, { ...input, outcome: 'success' } as never),
    });
    expect(rotated.key).toMatch(/^cen_test_[0-9A-Za-z]{32}$/);
    expect(rotated.record).toMatchObject({
      name: 'CI',
      scopes: ['workspaces:read', 'usage:write'],
      createdBy: users.member,
      workspaceId,
      revokedAt: null,
    });
    expect(t.keys.keys.get(oldId)?.revokedAt).not.toBeNull();
    expect(auditActions(t.store).slice(-2)).toEqual(['api_key.create', 'api_key.revoke']);
    expect(t.store.audit.at(-1)).toMatchObject({ actor_type: 'system', actor_id: 'admin-console' });
    await expect(
      t.apiKeys.rotateApiKey(oldId, staff, { audit: () => Promise.resolve('aud') }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('changes nothing when a step fails', async () => {
    const t = await apiKeysApp({ limit: null });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const oldId = String((await create(t, users.owner, keyBody(workspaceId))).json().id);
    const before = t.keys.keys.size;
    let calls = 0;
    await expect(
      t.apiKeys.rotateApiKey(
        oldId,
        { type: 'system', id: 'admin-console' },
        {
          audit: () =>
            ++calls === 2
              ? Promise.reject(new Error('audit write failed'))
              : Promise.resolve('aud'),
        },
      ),
    ).rejects.toThrow('audit write failed');
    expect(t.keys.keys.size).toBe(before);
    expect(t.keys.keys.get(oldId)?.revokedAt).toBeNull();
  });
});
