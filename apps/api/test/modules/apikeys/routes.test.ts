/**
 * `/v1/api-keys` over HTTP (B019 acceptance 1 and 7; card test routes.test.ts): the
 * CT-API-ACCOUNTS rows and shapes, the secret in exactly one response, CT-PAGE pages, an
 * `Idempotency-Key` replay that makes no second key, and the request checks.
 */
import { newId, validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { apiKeysApp, arrangeWorkspace, asUser } from './helpers.js';

type App = Awaited<ReturnType<typeof apiKeysApp>>;

const post = (t: App, userId: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { ...asUser(userId), ...headers },
    payload: payload as Record<string, unknown>,
  });

describe('POST /v1/api-keys (acceptance 1)', () => {
  it('answers 201 with an ApiKeyCreated holding the secret, never cached', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const res = await post(t, users.owner, {
      workspace: workspaceId,
      name: ' CI deploys ',
      scopes: ['workspaces:read'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<Record<string, unknown>>();
    expect(validate('api/ApiKeyCreated', body).ok).toBe(true);
    expect(body).toMatchObject({
      id: expect.stringMatching(/^key_/),
      workspace: workspaceId,
      name: 'CI deploys',
      scopes: ['workspaces:read'],
      created_by: users.owner,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    });
    expect(body['secret']).toMatch(/^cen_live_[0-9A-Za-z]{32}$/);
    expect(body['prefix']).toBe(String(body['secret']).slice(0, 12));
  });

  it('makes a test key with mode test, and keeps expires_at', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const res = await post(t, users.owner, {
      workspace: workspaceId,
      name: 'staging',
      scopes: ['workspaces:read'],
      mode: 'test',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(res.json()).toMatchObject({
      secret: expect.stringMatching(/^cen_test_/),
      expires_at: '2099-01-01T00:00:00.000Z',
    });
  });

  it('shows the secret in this response only: lists and replays of GET never hold it', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const created = await post(t, users.owner, {
      workspace: workspaceId,
      name: 'CI',
      scopes: ['workspaces:read'],
    });
    const secret = String(created.json().secret);
    const list = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?workspace=${workspaceId}`,
      headers: asUser(users.owner),
    });
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain(secret.slice(12));
    expect(Object.keys(list.json().data[0] as object)).not.toContain('secret');
  });

  it.each([
    [{ name: 'x', scopes: ['workspaces:read'] }, '/workspace'],
    [{ workspace: 'wsp_nope', name: 'x', scopes: ['workspaces:read'] }, '/workspace'],
    [{ workspace: 'W', name: '', scopes: ['workspaces:read'] }, '/name'],
    [{ workspace: 'W', name: 'x'.repeat(61), scopes: ['workspaces:read'] }, '/name'],
    [{ workspace: 'W', name: 'x', scopes: [] }, '/scopes'],
    [{ workspace: 'W', name: 'x', scopes: ['workspaces:read', 'workspaces:read'] }, '/scopes'],
    [{ workspace: 'W', name: 'x', scopes: 'workspaces:read' }, '/scopes'],
    [{ workspace: 'W', name: 'x', scopes: ['workspaces:read'], mode: 'prod' }, '/mode'],
    [
      { workspace: 'W', name: 'x', scopes: ['workspaces:read'], expires_at: 'tomorrow' },
      '/expires_at',
    ],
    [
      {
        workspace: 'W',
        name: 'x',
        scopes: ['workspaces:read'],
        expires_at: '2020-01-01T00:00:00Z',
      },
      '/expires_at',
    ],
    [{ workspace: 'W', name: 'x', scopes: ['workspaces:read'], secret: 'mine' }, '/secret'],
  ])('refuses %j with 422 pointing at %s', async (body, pointer) => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const payload = {
      ...body,
      ...((body as Record<string, unknown>)['workspace'] === 'W' ? { workspace: workspaceId } : {}),
    };
    const res = await post(t, users.owner, payload);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'validation_failed', errors: [{ pointer }] });
    expect(t.keys.keys.size).toBe(0);
  });

  it('needs workspaces:write (403) and a member of the workspace (404 otherwise)', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const other = arrangeWorkspace(t.store);
    const body = { workspace: workspaceId, name: 'x', scopes: ['workspaces:read'] };
    const readOnly = await t.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: asUser(users.owner, 'workspaces:read'),
      payload: body,
    });
    expect(readOnly.statusCode).toBe(403);
    expect((await post(t, other.users.owner, body)).statusCode).toBe(404);
    for (const role of ['billing', 'guest'] as const) {
      expect((await post(t, users[role], body)).statusCode).toBe(403);
    }
  });
});

describe('Idempotency-Key (acceptance 7)', () => {
  it('replays the same response and makes no second key', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const body = { workspace: workspaceId, name: 'CI', scopes: ['workspaces:read'] };
    const headers = { 'idempotency-key': newId('req').slice(4) };
    const first = await post(t, users.owner, body, headers);
    const again = await post(t, users.owner, body, headers);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(t.keys.keys.size).toBe(1);
  });

  it('keeps the stored copy of the response encrypted: no stored value holds the secret', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const written: string[] = [];
    const kv = t.redis.kv;
    const set = kv.set.bind(kv);
    const setIfAbsent = kv.setIfAbsent.bind(kv);
    kv.set = (key, value, opts) => {
      written.push(value);
      return set(key, value, opts);
    };
    kv.setIfAbsent = (key, value, ttlMs) => {
      written.push(value);
      return setIfAbsent(key, value, ttlMs);
    };
    const res = await post(
      t,
      users.owner,
      { workspace: workspaceId, name: 'CI', scopes: ['workspaces:read'] },
      { 'idempotency-key': newId('req').slice(4) },
    );
    const secret = String(res.json().secret);
    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(value).not.toContain(secret);
      expect(value).not.toContain(secret.slice(12));
    }
  });
});

describe('GET /v1/api-keys', () => {
  it('pages newest first with CT-PAGE cursors', async () => {
    const t = await apiKeysApp({ limit: null });
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      names.push(`k${i}`);
      await post(t, users.owner, {
        workspace: workspaceId,
        name: `k${i}`,
        scopes: ['workspaces:read'],
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/api-keys?workspace=${workspaceId}&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const res = await t.app.inject({ method: 'GET', url, headers: asUser(users.owner) });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-cache');
      const body = res.json<{
        data: { name: string }[];
        next_cursor: string | null;
        has_more: boolean;
      }>();
      expect(validate('api/ApiKeyPage', body).ok).toBe(true);
      seen.push(...body.data.map((k) => k.name));
      cursor = body.next_cursor;
      expect(body.has_more).toBe(cursor !== null);
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([...names].reverse());
  });

  it('does not take a cursor made for another workspace or owner', async () => {
    const t = await apiKeysApp({ limit: null });
    const a = arrangeWorkspace(t.store);
    for (let i = 0; i < 3; i++)
      await post(t, a.users.owner, {
        workspace: a.workspaceId,
        name: `k${i}`,
        scopes: ['workspaces:read'],
      });
    const first = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?workspace=${a.workspaceId}&limit=1`,
      headers: asUser(a.users.owner),
    });
    const cursor = String(first.json().next_cursor);
    const mine = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?limit=1&cursor=${cursor}`,
      headers: asUser(a.users.owner),
    });
    expect(mine.statusCode).toBe(400);
    expect(mine.json()).toMatchObject({ code: 'cursor_invalid' });
  });

  it('refuses a malformed workspace filter with 422', async () => {
    const t = await apiKeysApp();
    const { users } = arrangeWorkspace(t.store);
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/api-keys?workspace=acme',
      headers: asUser(users.owner),
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('DELETE /v1/api-keys/{id}', () => {
  it('answers 204, also a second time, and 404 for an unknown or malformed id', async () => {
    const t = await apiKeysApp();
    const { workspaceId, users } = arrangeWorkspace(t.store);
    const id = String(
      (
        await post(t, users.owner, {
          workspace: workspaceId,
          name: 'x',
          scopes: ['workspaces:read'],
        })
      ).json().id,
    );
    const del = (target: string) =>
      t.app.inject({
        method: 'DELETE',
        url: `/v1/api-keys/${target}`,
        headers: asUser(users.owner),
      });
    expect((await del(id)).statusCode).toBe(204);
    expect((await del(id)).statusCode).toBe(204);
    expect((await del('key_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).statusCode).toBe(404);
    expect((await del('nope')).statusCode).toBe(404);
    const listed = await t.app.inject({
      method: 'GET',
      url: `/v1/api-keys?workspace=${workspaceId}`,
      headers: asUser(users.owner),
    });
    expect(listed.json().data[0]).toMatchObject({ id, revoked_at: expect.any(String) });
  });
});
