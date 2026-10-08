/**
 * Settings through `PATCH /v1/workspaces/{id}` (B034, card test
 * workspace-settings.extension.test.ts, acceptance 6): a `settings` object there is stored exactly
 * as `/settings` stores it, under the workspace's ETag, with one version step for the workspace
 * and one for the settings; its refusals point under `/settings` and change nothing; it audits
 * and announces like `/settings`, once.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { asUser, createWorkspace } from '../workspaces/helpers.js';
import { settingsApp, settingsMessages, updateEvents, type SettingsApp } from './helpers.js';

const json = (res: { body: string }): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

const rows = (t: SettingsApp): Map<string, unknown> =>
  (t.settingsStore as unknown as { rows: Map<string, unknown> }).rows;

const patchWorkspace = (
  t: SettingsApp,
  id: string,
  owner: string,
  etag: string,
  payload: unknown,
) =>
  t.app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${id}`,
    headers: { ...asUser(owner), 'if-match': etag },
    payload: payload as Record<string, unknown>,
  });

describe('PATCH /v1/workspaces/{id} with settings (acceptance 6)', () => {
  it('stores what PATCH /settings stores, with a single ETag step for each', async () => {
    const t = await settingsApp();
    const owner = t.store.addUser();
    const viaWorkspace = await createWorkspace(t.app, owner, 'One');
    const viaSettings = await createWorkspace(t.app, owner, 'Two');
    const change = { share_history: false, auto_approve: 'trusted', history_retention_days: 5 };

    const a = await patchWorkspace(t, viaWorkspace.id, owner, viaWorkspace.etag, {
      settings: change,
    });
    expect(a.statusCode).toBe(200);
    expect(validate('api/Workspace', json(a)).ok).toBe(true);
    expect(a.headers['etag']).toBe('"v2"');
    const b = await t.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${viaSettings.id}/settings`,
      headers: { ...asUser(owner), 'if-match': '"s0"' },
      payload: change,
    });
    expect(b.statusCode).toBe(200);

    expect(rows(t).get(viaWorkspace.id)).toEqual(rows(t).get(viaSettings.id));
    expect(rows(t).get(viaWorkspace.id)).toEqual({
      autoApprove: 'trusted',
      shareHistory: false,
      retentionDays: 5,
      version: 1,
    });
    for (const id of [viaWorkspace.id, viaSettings.id]) {
      const got = await t.app.inject({
        url: `/v1/workspaces/${id}/settings`,
        headers: asUser(owner),
      });
      expect(json(got)).toEqual({
        auto_approve: 'trusted',
        share_history: false,
        history_retention_days: 5,
      });
      expect(got.headers['etag']).toBe('"s1"');
    }
    // The workspace moved on once; /settings left the workspace's version alone.
    expect(t.store.workspaces.get(viaWorkspace.id)?.version).toBe(2);
    expect(t.store.workspaces.get(viaSettings.id)?.version).toBe(1);
  });

  it('renames and changes settings in one step', async () => {
    const t = await settingsApp();
    const owner = t.store.addUser();
    const { id, etag } = await createWorkspace(t.app, owner);
    const res = await patchWorkspace(t, id, owner, etag, {
      name: 'Renamed',
      settings: { auto_approve: 'everyone' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)['name']).toBe('Renamed');
    expect(res.headers['etag']).toBe('"v2"');
    expect(rows(t).get(id)).toMatchObject({ autoApprove: 'everyone', version: 1 });
  });

  it("checks the workspace's ETag, not the settings'", async () => {
    const t = await settingsApp();
    const owner = t.store.addUser();
    const { id } = await createWorkspace(t.app, owner);
    const settingsEtag = await patchWorkspace(t, id, owner, '"s0"', {
      settings: { share_history: false },
    });
    expect(settingsEtag.statusCode).toBe(412);
    expect(rows(t).has(id)).toBe(false);
  });

  it('points refusals under /settings and changes nothing, the name included', async () => {
    const t = await settingsApp({ plan: 'pro' });
    const owner = t.store.addUser();
    const { id, etag } = await createWorkspace(t.app, owner);
    const bad = await patchWorkspace(t, id, owner, etag, {
      name: 'Renamed',
      settings: { auto_approve: 'always', share_history: 'no' },
    });
    expect(bad.statusCode).toBe(422);
    expect((json(bad)['errors'] as { pointer: string }[]).map((e) => e.pointer)).toEqual([
      '/settings/auto_approve',
      '/settings/share_history',
    ]);
    for (const settings of [null, 'x', [], {}]) {
      const res = await patchWorkspace(t, id, owner, etag, { settings });
      expect(res.statusCode).toBe(422);
      expect((json(res)['errors'] as { pointer: string }[])[0]?.pointer).toBe('/settings');
    }
    // Over the plan's cap (pro: 7 days): found in the transaction, which rolls back the rename.
    const over = await patchWorkspace(t, id, owner, etag, {
      name: 'Renamed',
      settings: { history_retention_days: 8 },
    });
    expect(over.statusCode).toBe(422);
    expect((json(over)['errors'] as { pointer: string }[])[0]?.pointer).toBe(
      '/settings/history_retention_days',
    );
    expect(t.store.workspaces.get(id)).toMatchObject({ name: 'Acme', version: 1 });
    expect(rows(t).has(id)).toBe(false);
    expect(settingsMessages(t)).toEqual([]);
  });

  it('audits the change and announces it once, after the commit', async () => {
    const t = await settingsApp();
    const owner = t.store.addUser();
    const { id, etag } = await createWorkspace(t.app, owner);
    const res = await patchWorkspace(t, id, owner, etag, {
      settings: { share_history: false, auto_approve: 'ask' },
    });
    expect(res.statusCode).toBe(200);
    expect(settingsMessages(t)).toEqual([
      {
        type: 'workspace.settings_changed',
        wsp: id,
        changed: ['share_history'],
        at: '2026-10-07T12:00:00.000Z',
      },
    ]);
    // B027's event for the PATCH, and the settings' own with the old and new values.
    expect(updateEvents(t.store).map((e) => e['meta'])).toEqual([
      { fields: 'share_history', share_history_from: true, share_history_to: false },
      { fields: 'settings' },
    ]);
  });

  it('announces nothing and writes no settings event when the settings do not change', async () => {
    const t = await settingsApp();
    const owner = t.store.addUser();
    const { id, etag } = await createWorkspace(t.app, owner);
    const res = await patchWorkspace(t, id, owner, etag, {
      settings: { share_history: true, auto_approve: 'ask', history_retention_days: null },
    });
    expect(res.statusCode).toBe(200);
    expect(settingsMessages(t)).toEqual([]);
    expect(rows(t).has(id)).toBe(false);
    expect(updateEvents(t.store).map((e) => e['meta'])).toEqual([{ fields: 'settings' }]);
  });
});
