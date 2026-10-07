/**
 * Workspace routes (B027, card test workspaces.routes.test.ts) over the in-memory store: create
 * with the caller as owner, idempotent replays and name limits (acceptance 1); ETag and If-Match
 * (acceptance 4); the CT-RBAC role matrix, with 404 for non-members (acceptance 5); delete by the
 * owner only, then 404 and a queued purge (acceptance 6); the owned-workspaces limit (acceptance
 * 8); audit events; two PATCHes with one ETag; API keys; and the failure modes of announcing and
 * queueing. Response bodies validate against CT-API-WORKSPACES.
 */
import { newId, validate } from '@centcom/contracts';
import {
  AUDIT_BATCH_INTERVAL_MS,
  FORBIDDEN_DETAIL,
  RBAC_INVALIDATE_CHANNEL,
  WORKSPACE_EVENTS_CHANNEL,
  WORKSPACE_PURGE_ATTEMPTS,
  WORKSPACE_PURGE_QUEUE,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_DETAILS,
  WORKSPACE_ROUTE_DETAILS,
} from '../../../src/modules/workspaces/index.js';
import { asKey, asUser, createWorkspace, workspacesApp } from './helpers.js';

const json = (res: { body: string }): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

describe('POST /v1/workspaces', () => {
  it('creates a workspace with the caller as owner, an ETag and a Location (acceptance 1)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'Acme Robotics' },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(validate('api/Workspace', body).ok).toBe(true);
    expect(body).toMatchObject({
      name: 'Acme Robotics',
      slug: 'acme-robotics',
      role: 'owner',
      owner: user,
      member_count: 1,
    });
    expect(res.headers['etag']).toBe('"v1"');
    expect(res.headers['location']).toBe(`/v1/workspaces/${String(body['id'])}`);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(store.memberships).toEqual([
      expect.objectContaining({ workspaceId: body['id'], userId: user, role: 'owner' }),
    ]);
    expect(store.audit).toEqual([
      expect.objectContaining({
        action: 'workspace.create',
        workspace_id: body['id'],
        actor_id: user,
        target_id: body['id'],
        request_id: res.headers['x-request-id'],
      }),
    ]);
  });

  it('replays the same Idempotency-Key with the same body (acceptance 1)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const request = {
      method: 'POST' as const,
      url: '/v1/workspaces',
      headers: { ...asUser(user), 'idempotency-key': newId('req').slice(4) },
      payload: { name: 'Acme' },
    };
    const first = await app.inject(request);
    const again = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toBe(first.body);
    expect(store.workspaces.size).toBe(1);
  });

  it('takes names of 1 to 60 characters, and refuses 0, 61 and control characters (acceptance 1, 2)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/v1/workspaces', headers: asUser(user), payload });
    expect((await post({ name: 'x'.repeat(60) })).statusCode).toBe(201);
    expect((await post({ name: 'é'.repeat(60) })).statusCode).toBe(201);
    for (const name of ['', 'x'.repeat(61), 'bell\u0007', 42]) {
      const res = await post({ name });
      expect(res.statusCode, JSON.stringify(name)).toBe(422);
      expect(json(res)).toMatchObject({ code: 'validation_failed' });
      expect((json(res)['errors'] as { pointer: string }[])[0]?.pointer).toBe('/name');
    }
    const missing = await post({});
    expect(missing.statusCode).toBe(422);
    expect(json(missing)['errors']).toEqual([
      { pointer: '/name', code: 'required', detail: 'is required' },
    ]);
    expect((await post(['Acme'])).statusCode).toBe(422);
  });

  it('stores a decomposed name NFC-normalised (acceptance 2)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const created = await createWorkspace(app, user, 'Café');
    expect(created.body['name']).toBe('Café');
    expect(store.workspaces.get(created.id)?.name).toBe('Café');
  });

  it('suffixes a taken slug, and refuses a taken slug the caller chose', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const slugs = [];
    for (let i = 0; i < 3; i++) slugs.push((await createWorkspace(app, user, 'Acme')).body['slug']);
    expect(slugs).toEqual(['acme', 'acme-2', 'acme-3']);
    const chosen = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'Other', slug: 'acme-2' },
    });
    expect(chosen.statusCode).toBe(409);
    expect(json(chosen)).toMatchObject({ code: 'conflict', detail: WORKSPACE_DETAILS.slugTaken });
    const free = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'Other', slug: 'my-own' },
    });
    expect(json(free)['slug']).toBe('my-own');
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'Other', slug: 'No Spaces' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('retries a slug race with new suffixes 5 times, then answers 409 (failure mode)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    store.slugRaces = 4;
    expect((await createWorkspace(app, user)).body['slug']).toBe('acme');
    store.slugRaces = 5;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(409);
    expect(json(res)['detail']).toBe(WORKSPACE_DETAILS.slugExhausted);
    expect(store.workspaces.size).toBe(1);
  });

  it('answers 409 for the 21st owned workspace, and counts only live ones (acceptance 8)', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await createWorkspace(app, user, `W${i}`)).id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: asUser(user),
      payload: { name: 'One too many' },
    });
    expect(res.statusCode).toBe(409);
    expect(json(res)['detail']).toBe(WORKSPACE_DETAILS.ownedLimit);
    // Workspaces where they are only a member do not count; deleting one frees a place.
    const other = store.addUser();
    store.join((await createWorkspace(app, other)).id, user, 'admin');
    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${ids[0] ?? ''}`,
      headers: asUser(user),
    });
    expect((await createWorkspace(app, user, 'Again')).body['role']).toBe('owner');
  });

  it('is for users only, with workspaces:write', async () => {
    const { app, store } = await workspacesApp();
    const user = store.addUser();
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/v1/workspaces', headers, payload: { name: 'Acme' } });
    const byKey = await post(asKey(newId('wsp')));
    expect(byKey.statusCode).toBe(403);
    expect(json(byKey)['detail']).toBe(WORKSPACE_ROUTE_DETAILS.usersOnly);
    expect((await post(asUser(user, 'workspaces:read'))).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(401);
  });
});

describe('GET, PATCH and DELETE /v1/workspaces/{id}', () => {
  it('serves the workspace with an ETag; PATCH needs If-Match, 412 when stale (acceptance 4)', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id, etag } = await createWorkspace(app, owner);
    const got = await app.inject({ url: `/v1/workspaces/${id}`, headers: asUser(owner) });
    expect(got.statusCode).toBe(200);
    expect(validate('api/Workspace', json(got)).ok).toBe(true);
    expect(got.headers['etag']).toBe(etag);
    const patch = (headers: Record<string, string>, payload: object = { name: 'Renamed' }) =>
      app.inject({ method: 'PATCH', url: `/v1/workspaces/${id}`, headers, payload });
    const noIfMatch = await patch(asUser(owner));
    expect(noIfMatch.statusCode).toBe(400);
    expect(json(noIfMatch)).toMatchObject({
      code: 'invalid_request',
      detail: WORKSPACE_ROUTE_DETAILS.ifMatchRequired,
    });
    const stale = await patch({ ...asUser(owner), 'if-match': '"v9"' });
    expect(stale.statusCode).toBe(412);
    expect(json(stale)).toMatchObject({ code: 'precondition_failed' });
    const ok = await patch({ ...asUser(owner), 'if-match': etag });
    expect(ok.statusCode).toBe(200);
    expect(json(ok)['name']).toBe('Renamed');
    expect(ok.headers['etag']).toBe('"v2"');
    expect((await patch({ ...asUser(owner), 'if-match': etag })).statusCode).toBe(412);
    expect((await patch({ ...asUser(owner), 'if-match': '*' }, { name: 'Any' })).statusCode).toBe(
      200,
    );
    expect(store.audit.filter((r) => r['action'] === 'workspace.update')).toEqual([
      expect.objectContaining({ workspace_id: id, target_id: id, meta: '{"fields":"name"}' }),
      expect.objectContaining({ workspace_id: id }),
    ]);
  });

  it('ignores unknown fields, and refuses a body with nothing it can change', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id, etag } = await createWorkspace(app, owner);
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(owner), 'if-match': etag },
        payload,
      });
    for (const payload of [{}, { settings: { share_history: true } }, { slug: 'new' }]) {
      const res = await patch(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    const res = await patch({ name: 'Renamed', settings: { share_history: true }, owner: 'x' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).not.toHaveProperty('settings');
    expect((await patch({ name: '' })).statusCode).toBe(422);
  });

  it('lets a registered extension own a PATCH field, applied in the same transaction', async () => {
    const { app, store, extensions } = await workspacesApp();
    const applied: unknown[] = [];
    extensions.register({
      key: 'settings',
      parse: (value) =>
        typeof value === 'object' && value !== null
          ? { value }
          : { issues: [{ pointer: '', code: 'invalid_type', detail: 'must be an object' }] },
      apply: (tx, workspaceId, value) => {
        expect(tx.trx.isTransaction).toBe(true);
        applied.push({ workspaceId, value });
        if ((value as { fail?: boolean }).fail === true) throw new Error('extension failed');
        return Promise.resolve();
      },
    });
    const [settings] = extensions.list();
    if (settings === undefined) throw new Error('the extension was not registered');
    expect(() => extensions.register({ ...settings })).toThrow(/already/);
    expect(() =>
      extensions.register({
        key: 'name',
        parse: () => ({ value: 1 }),
        apply: () => Promise.resolve(),
      }),
    ).toThrow(TypeError);
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(owner), 'if-match': '*' },
        payload,
      });
    expect((await patch({ settings: { share_history: true } })).statusCode).toBe(200);
    expect(applied).toEqual([{ workspaceId: id, value: { share_history: true } }]);
    const bad = await patch({ settings: 'on' });
    expect(bad.statusCode).toBe(422);
    expect((json(bad)['errors'] as { pointer: string }[])[0]?.pointer).toBe('/settings');
    // A failing extension rolls the whole PATCH back: name and version stay.
    const failed = await patch({ name: 'Never', settings: { fail: true } });
    expect(failed.statusCode).toBe(500);
    expect(store.workspaces.get(id)).toMatchObject({ name: 'Acme', version: 2 });
    expect(store.audit.filter((r) => r['action'] === 'workspace.update')).toHaveLength(1);
  });

  it('applies the CT-RBAC matrix, with 404 for everyone who is not a member (acceptance 5, 6)', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    const roles = ['admin', 'member', 'billing', 'guest'] as const;
    const users = Object.fromEntries(roles.map((role) => [role, store.addUser()]));
    for (const role of roles) store.join(id, users[role] ?? '', role);
    const outsider = store.addUser();
    const call = (method: 'GET' | 'PATCH' | 'DELETE', userId: string) =>
      app.inject({
        method,
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(userId), 'if-match': '*' },
        ...(method === 'PATCH' ? { payload: { name: 'Renamed' } } : {}),
      });
    const status = async (method: 'GET' | 'PATCH' | 'DELETE', userId: string) =>
      (await call(method, userId)).statusCode;
    for (const role of roles) expect(await status('GET', users[role] ?? ''), role).toBe(200);
    expect(json(await call('GET', users['guest'] ?? ''))).toEqual({ id, name: 'Acme' });
    expect(await status('PATCH', users['member'] ?? '')).toBe(403);
    expect(await status('PATCH', users['billing'] ?? '')).toBe(403);
    expect(await status('PATCH', users['guest'] ?? '')).toBe(403);
    const denied = await call('PATCH', users['member'] ?? '');
    expect(json(denied)).toMatchObject({ code: 'forbidden', detail: FORBIDDEN_DETAIL });
    expect(await status('PATCH', users['admin'] ?? '')).toBe(200);
    expect(await status('DELETE', users['admin'] ?? '')).toBe(403);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const res = await call(method, outsider);
      expect(res.statusCode, method).toBe(404);
      expect(json(res)).toMatchObject({ code: 'not_found', detail: WORKSPACE_DETAILS.notFound });
    }
    expect(await status('GET', 'usr_bogus')).toBe(404);
    expect(
      (await app.inject({ url: '/v1/workspaces/acme', headers: asUser(owner) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/v1/workspaces/${newId('wsp')}`, headers: asUser(owner) }))
        .statusCode,
    ).toBe(404);
  });

  it('deletes for the owner: 204, every read 404, the purge queued, the deletion announced (acceptance 6)', async () => {
    const { app, store, queue, published, emitter, detached } = await workspacesApp();
    const owner = store.addUser();
    const admin = store.addUser();
    const { id } = await createWorkspace(app, owner);
    store.join(id, admin, 'admin');
    const refused = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}`,
      headers: asUser(admin),
    });
    expect(refused.statusCode).toBe(403);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}`,
      headers: asUser(owner),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    for (const userId of [owner, admin]) {
      expect(
        (await app.inject({ url: `/v1/workspaces/${id}`, headers: asUser(userId) })).statusCode,
      ).toBe(404);
    }
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/workspaces/${id}`, headers: asUser(owner) }))
        .statusCode,
    ).toBe(404);
    const list = await app.inject({ url: '/v1/workspaces', headers: asUser(owner) });
    expect(json(list)['data']).toEqual([]);
    expect(queue.jobs).toEqual([
      {
        name: WORKSPACE_PURGE_QUEUE,
        data: { workspaceId: id },
        opts: expect.objectContaining({
          jobId: `purge-${id}`,
          attempts: WORKSPACE_PURGE_ATTEMPTS,
        }) as unknown,
      },
    ]);
    const announced = published.find((p) => p.channel === WORKSPACE_EVENTS_CHANNEL);
    expect(JSON.parse(announced?.message ?? '{}')).toMatchObject({
      type: 'workspace.deleted',
      wsp: id,
    });
    expect(published.some((p) => p.channel === RBAC_INVALIDATE_CHANNEL)).toBe(true);
    // The deletion is recorded at account level (it outlives the workspace's own events).
    expect(store.audit.filter((r) => r['action'] === 'workspace.delete')).toEqual([
      expect.objectContaining({
        workspace_id: null,
        target_type: 'workspace',
        target_id: id,
        actor_id: owner,
      }),
    ]);
    // The admin's refused attempt was audited by RBAC (CT-RBAC rule 6).
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(detached).toEqual([
      expect.objectContaining({ action: 'permission.denied', outcome: 'denied', actor_id: admin }),
    ]);
  });

  it('refuses a DELETE with a stale If-Match', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}`,
      headers: { ...asUser(owner), 'if-match': '"v7"' },
    });
    expect(res.statusCode).toBe(412);
    expect(store.workspaces.get(id)?.deletedAt).toBeNull();
  });

  it('still deletes when announcing or queueing fails, counting and logging it (failure mode)', async () => {
    const { app, store, queue, recorded, captured } = await workspacesApp({ failPublish: true });
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    queue.fail = true;
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}`,
      headers: asUser(owner),
    });
    expect(res.statusCode).toBe(204);
    expect(store.workspaces.get(id)?.deletedAt).toBeInstanceOf(Date);
    expect(recorded.count('workspace_announce_failures_total')).toBe(1);
    expect(recorded.count('workspace_purge_enqueue_failures_total')).toBe(1);
    const lines = captured.lines().map((l) => l['msg']);
    expect(lines).toContain('workspace.announce_failed');
    expect(lines).toContain('workspace.purge_enqueue_failed');
  });

  it('lets exactly one of two PATCHes with the same ETag win (failure mode)', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id, etag } = await createWorkspace(app, owner);
    const patch = (name: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(owner), 'if-match': etag },
        payload: { name },
      });
    const results = await Promise.all([patch('First'), patch('Second')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
    expect(store.workspaces.get(id)?.version).toBe(2);
  });

  it('serves an API key its own workspace only, and lets it update but not delete', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    const key = asKey(id);
    const got = await app.inject({ url: `/v1/workspaces/${id}`, headers: key });
    expect(got.statusCode).toBe(200);
    expect(json(got)).not.toHaveProperty('role');
    expect(validate('api/Workspace', json(got)).ok).toBe(true);
    const otherWorkspace = (await createWorkspace(app, owner, 'Other')).id;
    expect(
      (await app.inject({ url: `/v1/workspaces/${otherWorkspace}`, headers: key })).statusCode,
    ).toBe(404);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${id}`,
      headers: { ...key, 'if-match': '*' },
      payload: { name: 'By key' },
    });
    expect(patched.statusCode).toBe(200);
    expect(store.audit.at(-1)).toMatchObject({ action: 'workspace.update', actor_type: 'api_key' });
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/workspaces/${id}`, headers: key }))
        .statusCode,
    ).toBe(403);
    const list = await app.inject({ url: '/v1/workspaces', headers: key });
    expect((json(list)['data'] as { id: string }[]).map((w) => w.id)).toEqual([id]);
    expect(validate('api/WorkspacePage', json(list)).ok).toBe(true);
  });

  it('needs authentication and the right scope', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const { id } = await createWorkspace(app, owner);
    expect((await app.inject({ url: `/v1/workspaces/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/workspaces' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `/v1/workspaces/${id}`, headers: asUser(owner, 'profile') }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/workspaces/${id}`,
          headers: asUser(owner, 'workspaces:read'),
        })
      ).statusCode,
    ).toBe(403);
  });
});
