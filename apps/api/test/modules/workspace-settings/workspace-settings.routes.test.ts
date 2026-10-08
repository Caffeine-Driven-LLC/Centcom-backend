/**
 * Settings routes (B034, card test workspace-settings.routes.test.ts) over the in-memory stores:
 * the defaults with an ETag until the first PATCH creates the row (acceptance 1); the role matrix,
 * with 404 for non-members and deleted workspaces and 403 for guests (acceptance 2); If-Match
 * required, stale ETags 412, and settings ETags kept apart from the workspace's (acceptance 2);
 * two PATCHes with one ETag (acceptance 7); API keys. Bodies validate against CT-API-WORKSPACES.
 */
import { newId, validate } from '@centcom/contracts';
import { AUDIT_BATCH_INTERVAL_MS, type WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_DETAILS,
  SETTINGS_ROUTE_DETAILS,
} from '../../../src/modules/workspace-settings/index.js';
import { asKey, asUser, createWorkspace } from '../workspaces/helpers.js';
import { settingsApp, type SettingsApp } from './helpers.js';

const json = (res: { body: string }): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

/** A workspace owned by a new user, and a member of each role in it. */
async function workspaceWithRoles(t: SettingsApp): Promise<{
  id: string;
  owner: string;
  roles: Record<Exclude<WorkspaceRole, 'owner'>, string>;
}> {
  const owner = t.store.addUser();
  const { id } = await createWorkspace(t.app, owner);
  const roles = {} as Record<Exclude<WorkspaceRole, 'owner'>, string>;
  for (const role of ['admin', 'member', 'billing', 'guest'] as const) {
    const user = t.store.addUser();
    t.store.join(id, user, role);
    roles[role] = user;
  }
  return { id, owner, roles };
}

const patch = (
  t: SettingsApp,
  id: string,
  headers: Record<string, string>,
  payload: unknown,
  /** null: no If-Match header. */
  ifMatch: string | null = '"s0"',
) =>
  t.app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${id}/settings`,
    headers: { ...headers, ...(ifMatch === null ? {} : { 'if-match': ifMatch }) },
    payload: payload as Record<string, unknown>,
  });

describe('GET /v1/workspaces/{id}/settings', () => {
  it('answers the defaults with ETag "s0" while the workspace has no row (acceptance 1)', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const res = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      auto_approve: 'ask',
      share_history: true,
      history_retention_days: null,
    });
    expect(validate('api/WorkspaceSettings', json(res)).ok).toBe(true);
    expect(res.headers['etag']).toBe('"s0"');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(t.settingsStore).toMatchObject({ rows: new Map() });
  });

  it('lets every member role read, refuses guests with 403 and strangers with 404', async () => {
    const t = await settingsApp();
    const { id, owner, roles } = await workspaceWithRoles(t);
    for (const user of [owner, roles.admin, roles.member, roles.billing]) {
      const res = await t.app.inject({
        url: `/v1/workspaces/${id}/settings`,
        headers: asUser(user),
      });
      expect(res.statusCode).toBe(200);
    }
    const guest = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(roles.guest),
    });
    expect(guest.statusCode).toBe(403);
    expect(json(guest)['detail']).toBe(SETTINGS_ROUTE_DETAILS.guests);
    const stranger = t.store.addUser();
    for (const url of [
      `/v1/workspaces/${id}/settings`,
      `/v1/workspaces/${newId('wsp')}/settings`,
      '/v1/workspaces/not-an-id/settings',
    ]) {
      const res = await t.app.inject({ url, headers: asUser(stranger) });
      expect(res.statusCode).toBe(404);
      expect(json(res)['code']).toBe('not_found');
    }
  });

  it('answers 404 once the workspace is deleted, and 401 without a caller', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}`,
      headers: asUser(owner),
    });
    expect(del.statusCode).toBe(204);
    const gone = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(gone.statusCode).toBe(404);
    expect((await t.app.inject({ url: `/v1/workspaces/${id}/settings` })).statusCode).toBe(401);
  });

  it('needs workspaces:read', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const res = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner, 'profile'),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /v1/workspaces/{id}/settings', () => {
  it('creates the row on the first PATCH, then moves the ETag on with each change (acceptance 1)', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const first = await patch(t, id, asUser(owner), { share_history: false });
    expect(first.statusCode).toBe(200);
    expect(json(first)).toEqual({
      auto_approve: 'ask',
      share_history: false,
      history_retention_days: null,
    });
    expect(validate('api/WorkspaceSettings', json(first)).ok).toBe(true);
    expect(first.headers['etag']).toBe('"s1"');
    expect((t.settingsStore as unknown as { rows: Map<string, unknown> }).rows.get(id)).toEqual({
      autoApprove: 'ask',
      shareHistory: false,
      retentionDays: null,
      version: 1,
    });
    const second = await patch(t, id, asUser(owner), { auto_approve: 'trusted' }, '"s1"');
    expect(second.statusCode).toBe(200);
    expect(second.headers['etag']).toBe('"s2"');
    const got = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(json(got)).toEqual({
      auto_approve: 'trusted',
      share_history: false,
      history_retention_days: null,
    });
    expect(got.headers['etag']).toBe('"s2"');
  });

  it('lets owners and admins change settings; members, billing and guests get 403 (acceptance 2)', async () => {
    const t = await settingsApp();
    const { id, owner, roles } = await workspaceWithRoles(t);
    for (const user of [roles.member, roles.billing, roles.guest]) {
      const res = await patch(t, id, asUser(user), { share_history: false });
      expect(res.statusCode).toBe(403);
      expect(json(res)['code']).toBe('forbidden');
    }
    const byAdmin = await patch(t, id, asUser(roles.admin), { share_history: false });
    expect(byAdmin.statusCode).toBe(200);
    const byOwner = await patch(t, id, asUser(owner), { share_history: true }, '"s1"');
    expect(byOwner.statusCode).toBe(200);
    // The refusals are privileged denials: audited.
    await t.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(t.detached.filter((row) => row['action'] === 'permission.denied')).toHaveLength(3);
    const stranger = t.store.addUser();
    expect((await patch(t, id, asUser(stranger), { share_history: false })).statusCode).toBe(404);
  });

  it('needs If-Match (400), refuses a stale or foreign ETag (412), and accepts * (acceptance 2)', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const missing = await patch(t, id, asUser(owner), { share_history: false }, null);
    expect(missing.statusCode).toBe(400);
    expect(json(missing)).toMatchObject({
      code: 'invalid_request',
      detail: SETTINGS_ROUTE_DETAILS.ifMatchRequired,
    });
    expect((await patch(t, id, asUser(owner), { share_history: false })).statusCode).toBe(200);
    for (const etag of ['"s0"', 'W/"s1"', '"v1"', '"s01"', 's1', '"s2"']) {
      const res = await patch(t, id, asUser(owner), { auto_approve: 'everyone' }, etag);
      expect(res.statusCode).toBe(412);
      expect(json(res)).toMatchObject({
        code: 'precondition_failed',
        detail: SETTINGS_DETAILS.stale,
      });
    }
    const listed = await patch(t, id, asUser(owner), { auto_approve: 'everyone' }, '"s9", "s1"');
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['etag']).toBe('"s2"');
    const any = await patch(t, id, asUser(owner), { auto_approve: 'ask' }, '*');
    expect(any.statusCode).toBe(200);
    expect(any.headers['etag']).toBe('"s3"');
  });

  it('gives one of two PATCHes made with one ETag a 200 and the other a 412 (acceptance 7)', async () => {
    const t = await settingsApp();
    const { id, owner, roles } = await workspaceWithRoles(t);
    const [a, b] = await Promise.all([
      patch(t, id, asUser(owner), { auto_approve: 'trusted' }),
      patch(t, id, asUser(roles.admin), { auto_approve: 'everyone' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 412]);
    const winner = a.statusCode === 200 ? 'trusted' : 'everyone';
    const got = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(json(got)['auto_approve']).toBe(winner);
    expect(got.headers['etag']).toBe('"s1"');
  });

  it('answers 404 for a workspace deleted since, without writing anything', async () => {
    const t = await settingsApp();
    const { id, owner } = await workspaceWithRoles(t);
    const row = t.store.workspaces.get(id);
    if (row === undefined) throw new Error('no workspace');
    // Deleted between the RBAC check and the transaction: the store's lock finds no live row.
    const reader = t.store.reader.workspaceRole.bind(t.store.reader);
    t.store.reader.workspaceRole = async (userId, workspaceId) => {
      const role = await reader(userId, workspaceId);
      row.deletedAt = new Date();
      return role;
    };
    const res = await patch(t, id, asUser(owner), { share_history: false });
    expect(res.statusCode).toBe(404);
    expect(t.settingsStore).toMatchObject({ rows: new Map() });
  });
});

describe('API keys', () => {
  it("reads and changes its own workspace's settings with the right scopes, 404 elsewhere", async () => {
    const t = await settingsApp();
    const { id } = await workspaceWithRoles(t);
    const read = await t.app.inject({ url: `/v1/workspaces/${id}/settings`, headers: asKey(id) });
    expect(read.statusCode).toBe(200);
    expect((await patch(t, id, asKey(id), { share_history: false })).statusCode).toBe(200);
    const readOnly = await patch(
      t,
      id,
      asKey(id, 'workspaces:read'),
      { share_history: true },
      '"s1"',
    );
    expect(readOnly.statusCode).toBe(403);
    const other = newId('wsp');
    expect(
      (await t.app.inject({ url: `/v1/workspaces/${id}/settings`, headers: asKey(other) }))
        .statusCode,
    ).toBe(404);
  });
});
