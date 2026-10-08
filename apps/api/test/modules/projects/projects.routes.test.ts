/**
 * Project routes (B035, card test projects.routes.test.ts): CRUD and the RBAC matrix
 * (acceptance 1 and 4), names unique per workspace ignoring case (acceptance 2), ETags and
 * `If-Match`, idempotent creates, outsiders and other workspaces' projects answered with 404,
 * audit events, and bodies valid against CT-API-WORKSPACES (`Project`, `ProjectPage`).
 */
import { randomUUID } from 'node:crypto';
import { newId, validate } from '@centcom/contracts';
import { AUDIT_BATCH_INTERVAL_MS, type WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { PROJECT_DETAILS } from '../../../src/modules/projects/index.js';
import {
  arrange,
  asKey,
  createProject,
  headersOf,
  projectsApp,
  type ProjectsApp,
} from './helpers.js';

const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'billing', 'guest'];

const list = (t: ProjectsApp, workspaceId: string, headers: Record<string, string>) =>
  t.app.inject({ method: 'GET', url: `/v1/workspaces/${workspaceId}/projects`, headers });

const patch = (
  t: ProjectsApp,
  projectId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown> = { name: `Renamed ${randomUUID().slice(0, 6)}` },
) => t.app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}`, headers, payload });

const remove = (t: ProjectsApp, projectId: string, headers: Record<string, string>) =>
  t.app.inject({ method: 'DELETE', url: `/v1/projects/${projectId}`, headers });

describe('creating a project', () => {
  it('answers a member with 201, the project and its ETag (acceptance 1)', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, {
      name: 'Api',
      repo: 'github.com/acme/app',
    });
    expect(created.status).toBe(201);
    expect(validate('api/Project', created.body).ok).toBe(true);
    expect(created.body).toEqual({
      id: created.id,
      workspace: workspaceId,
      name: 'Api',
      repo: 'github.com/acme/app',
      created_at: expect.any(String) as unknown,
    });
    expect(created.etag).toBe('"v1"');
    expect(created.headers['cache-control']).toBe('private, no-cache');
    expect(t.projectStore.rows.get(created.id)).toMatchObject({
      createdBy: users.member,
      repoRef: 'github.com/acme/app',
    });
    expect(t.store.audit.filter((r) => r['action'] === 'workspace.update')).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        actor_id: users.member,
        target_type: 'project',
        target_id: created.id,
        meta: '{"fields":"project"}',
      }),
    ]);
  });

  it('stores no repo when none is given, and answers it as null', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.owner, { name: 'Web' });
    expect(created.status).toBe(201);
    expect(created.body['repo']).toBeNull();
    expect(validate('api/Project', created.body).ok).toBe(true);
  });

  it('lets owner, admin and member create; refuses billing and guest with 403, audited', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const status: Record<string, number> = {};
    for (const role of ROLES) {
      status[role] = (await createProject(t.app, workspaceId, users[role])).status;
    }
    expect(status).toEqual({ owner: 201, admin: 201, member: 201, billing: 403, guest: 403 });
    expect(t.projectStore.rows.size).toBe(3);
    await t.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(t.detached.filter((r) => r['action'] === 'permission.denied')).toEqual([
      expect.objectContaining({ outcome: 'denied', actor_id: users.billing }),
      expect.objectContaining({ outcome: 'denied', actor_id: users.guest }),
    ]);
  });

  it('answers a non-member, and an unknown or malformed workspace, with 404', async () => {
    const t = await projectsApp();
    const { workspaceId } = arrange(t.store);
    const outsider = t.store.addUser();
    expect((await createProject(t.app, workspaceId, outsider)).status).toBe(404);
    expect((await createProject(t.app, newId('wsp'), outsider)).status).toBe(404);
    expect((await createProject(t.app, 'nope', outsider)).status).toBe(404);
    expect(t.projectStore.rows.size).toBe(0);
  });

  it('refuses API keys until CT-RBAC has a projects row: 403 whatever the workspace', async () => {
    const t = await projectsApp();
    const { workspaceId } = arrange(t.store);
    const other = arrange(t.store).workspaceId;
    const own = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/projects`,
      headers: asKey(workspaceId),
      payload: { name: 'Api' },
    });
    expect(own.statusCode).toBe(403);
    expect(t.projectStore.rows.size).toBe(0);
    // `session.create` is closed to API keys before any workspace is looked at, so the answer is
    // the same for another workspace and for one that does not exist: nothing is confirmed.
    for (const target of [other, newId('wsp')]) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/workspaces/${target}/projects`,
        headers: asKey(workspaceId),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('needs the workspaces:write scope', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/projects`,
      headers: { 'x-test-user': users.member, 'x-test-scopes': 'workspaces:read' },
      payload: { name: 'Api' },
    });
    expect(res.statusCode).toBe(403);
    expect(t.projectStore.rows.size).toBe(0);
  });

  it('replays the same Idempotency-Key with Idempotency-Replayed: true, creating once', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const key = randomUUID();
    const first = await createProject(t.app, workspaceId, users.member, { name: 'Api' }, key);
    const again = await createProject(t.app, workspaceId, users.member, { name: 'Api' }, key);
    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(t.projectStore.rows.size).toBe(1);
    expect(t.store.audit.filter((r) => r['action'] === 'workspace.update')).toHaveLength(1);
    // Another body with the same key is a conflict.
    const other = await createProject(t.app, workspaceId, users.member, { name: 'Web' }, key);
    expect(other.status).toBe(409);
  });

  it('keeps names unique per workspace ignoring case, not across workspaces (acceptance 2)', async () => {
    const t = await projectsApp();
    const a = arrange(t.store);
    const b = arrange(t.store);
    expect(
      (await createProject(t.app, a.workspaceId, a.users.member, { name: 'Api' })).status,
    ).toBe(201);
    const clash = await createProject(t.app, a.workspaceId, a.users.admin, { name: 'api' });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'conflict', detail: PROJECT_DETAILS.nameTaken });
    expect(
      (await createProject(t.app, b.workspaceId, b.users.member, { name: 'api' })).status,
    ).toBe(201);
    expect(t.projectStore.rows.size).toBe(2);
  });

  it('gives one project to concurrent creates of one name (409 for the rest, never 500)', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    let open: () => void = () => undefined;
    t.projectStore.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const racing = Array.from({ length: 5 }, (_, i) =>
      createProject(t.app, workspaceId, users.member, { name: i % 2 === 0 ? 'Api' : 'API' }),
    );
    while (t.projectStore.waiting < 5) await new Promise((r) => setImmediate(r));
    t.projectStore.gate = undefined;
    open();
    const statuses = (await Promise.all(racing)).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(t.projectStore.rows.size).toBe(1);
  });

  it('answers 404 when the workspace was deleted', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const row = t.store.workspaces.get(workspaceId);
    if (row !== undefined) row.deletedAt = new Date();
    expect((await createProject(t.app, workspaceId, users.member)).status).toBe(404);
  });
});

describe('listing projects', () => {
  it('answers owner, admin and member with the projects; 403 for billing and guest', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    for (const role of ['owner', 'admin', 'member'] as const) {
      const res = await list(t, workspaceId, headersOf(users[role]));
      expect(res.statusCode, role).toBe(200);
      const page = res.json<Record<string, unknown>>();
      expect(validate('api/ProjectPage', page).ok).toBe(true);
      expect(page).toEqual({ data: [created.body], next_cursor: null, has_more: false });
      expect(res.headers['cache-control']).toBe('private, no-cache');
    }
    // CT-RBAC: a guest sees nothing of a workspace's projects; billing is not member+.
    expect((await list(t, workspaceId, headersOf(users.billing))).statusCode).toBe(403);
    expect((await list(t, workspaceId, headersOf(users.guest))).statusCode).toBe(403);
    expect((await list(t, workspaceId, headersOf(t.store.addUser()))).statusCode).toBe(404);
  });

  it('lists only the workspace’s own projects', async () => {
    const t = await projectsApp();
    const a = arrange(t.store);
    const b = arrange(t.store);
    await createProject(t.app, a.workspaceId, a.users.member, { name: 'Api' });
    await createProject(t.app, b.workspaceId, b.users.member, { name: 'Web' });
    const page = (await list(t, a.workspaceId, headersOf(a.users.member))).json<{
      data: { name: string }[];
    }>();
    expect(page.data.map((p) => p.name)).toEqual(['Api']);
  });
});

describe('updating a project', () => {
  it('lets owner, admin and member rename and move the ETag on; 403 for billing and guest', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    const status: Record<string, number> = {};
    for (const role of ROLES)
      status[role] = (await patch(t, created.id, headersOf(users[role]))).statusCode;
    expect(status).toEqual({ owner: 200, admin: 200, member: 200, billing: 403, guest: 403 });
    expect(t.projectStore.rows.get(created.id)?.version).toBe(4);
  });

  it('answers the project and its new ETag; null clears the repo; unknown fields are ignored', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, {
      name: 'Api',
      repo: 'github.com/acme/app',
    });
    const renamed = await patch(t, created.id, headersOf(users.member), {
      name: 'Gateway',
      created_by: 'usr_x',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.headers['etag']).toBe('"v2"');
    expect(validate('api/Project', renamed.json()).ok).toBe(true);
    expect(renamed.json()).toMatchObject({
      id: created.id,
      name: 'Gateway',
      repo: 'github.com/acme/app',
    });
    const cleared = await patch(t, created.id, headersOf(users.member), { repo: null });
    expect(cleared.json()).toMatchObject({ name: 'Gateway', repo: null });
    expect(cleared.headers['etag']).toBe('"v3"');
    expect(t.projectStore.rows.get(created.id)?.createdBy).toBe(users.member);
    expect(
      t.store.audit.filter((r) => r['target_type'] === 'project').map((r) => r['meta']),
    ).toEqual(['{"fields":"project"}', '{"fields":"name"}', '{"fields":"repo"}']);
  });

  it('checks If-Match when given: 412 precondition_failed when stale, nothing changed', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    const etag = created.etag ?? '';
    const ok = await patch(t, created.id, { ...headersOf(users.member), 'if-match': etag });
    expect(ok.statusCode).toBe(200);
    const stale = await patch(
      t,
      created.id,
      { ...headersOf(users.member), 'if-match': etag },
      {
        name: 'Late',
      },
    );
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'precondition_failed' });
    expect(t.projectStore.rows.get(created.id)?.name).not.toBe('Late');
    const any = await patch(t, created.id, { ...headersOf(users.member), 'if-match': '*' });
    expect(any.statusCode).toBe(200);
  });

  it('refuses a taken name with 409 and an empty body with 422', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const api = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    await createProject(t.app, workspaceId, users.member, { name: 'Web' });
    expect((await patch(t, api.id, headersOf(users.member), { name: 'WEB' })).statusCode).toBe(409);
    expect(t.projectStore.rows.get(api.id)).toMatchObject({ name: 'Api', version: 1 });
    // Its own name in another case is fine.
    expect((await patch(t, api.id, headersOf(users.member), { name: 'API' })).statusCode).toBe(200);
    const empty = await patch(t, api.id, headersOf(users.member), {});
    expect(empty.statusCode).toBe(422);
  });

  it('answers 404, alike, for an unknown project and one of a workspace the caller is not in', async () => {
    const t = await projectsApp();
    const a = arrange(t.store);
    const b = arrange(t.store);
    const theirs = await createProject(t.app, b.workspaceId, b.users.member, { name: 'Api' });
    const foreign = await patch(t, theirs.id, headersOf(a.users.owner));
    const unknown = await patch(t, newId('prj'), headersOf(a.users.owner));
    const malformed = await patch(t, 'prj_nope', headersOf(a.users.owner));
    for (const res of [foreign, unknown, malformed]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found', detail: PROJECT_DETAILS.notFound });
    }
    expect(t.projectStore.rows.get(theirs.id)?.name).toBe('Api');
  });
});

describe('deleting a project', () => {
  it('lets owner and admin delete (204); refuses member, billing and guest with 403 (acceptance 4)', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    for (const role of ['member', 'billing', 'guest'] as const) {
      expect((await remove(t, created.id, headersOf(users[role]))).statusCode, role).toBe(403);
    }
    expect(t.projectStore.rows.has(created.id)).toBe(true);
    const res = await remove(t, created.id, headersOf(users.admin));
    expect(res.statusCode).toBe(204);
    expect(t.projectStore.rows.has(created.id)).toBe(false);
    expect((await remove(t, created.id, headersOf(users.admin))).statusCode).toBe(404);
    const second = await createProject(t.app, workspaceId, users.member, { name: 'Web' });
    expect((await remove(t, second.id, headersOf(users.owner))).statusCode).toBe(204);
    const audited = t.store.audit.filter((r) => r['target_type'] === 'project');
    expect(audited.at(-1)).toMatchObject({
      action: 'workspace.update',
      workspace_id: workspaceId,
      actor_id: users.owner,
      target_id: second.id,
      meta: '{"fields":"project"}',
    });
  });

  it('answers 404 for a project of another workspace, even to its own workspace’s admin (acceptance 4)', async () => {
    const t = await projectsApp();
    const a = arrange(t.store);
    const b = arrange(t.store);
    const theirs = await createProject(t.app, b.workspaceId, b.users.member, { name: 'Api' });
    expect((await remove(t, theirs.id, headersOf(a.users.admin))).statusCode).toBe(404);
    expect(t.projectStore.rows.has(theirs.id)).toBe(true);
  });

  it('answers 404 once the workspace is deleted', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createProject(t.app, workspaceId, users.member, { name: 'Api' });
    const row = t.store.workspaces.get(workspaceId);
    if (row !== undefined) row.deletedAt = new Date();
    expect((await remove(t, created.id, headersOf(users.owner))).statusCode).toBe(404);
    expect((await patch(t, created.id, headersOf(users.owner))).statusCode).toBe(404);
    expect((await list(t, workspaceId, headersOf(users.owner))).statusCode).toBe(404);
  });
});
