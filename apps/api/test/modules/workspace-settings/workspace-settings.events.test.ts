/**
 * Announcements and audit (B034, card test workspace-settings.events.test.ts, acceptance 5): a
 * successful PATCH publishes exactly one `workspace.settings_changed` on
 * `centcom:workspace-events` naming only the changed keys; its audit event carries the key names
 * and old and new values (enums, flags, days) and no free text; a PATCH that changes nothing
 * announces and audits nothing; a failing publish is retried 3 times, then logged and counted,
 * and the stored value stands.
 */
import { WORKSPACE_EVENTS_CHANNEL } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_PUBLISH_ATTEMPTS,
  SETTINGS_PUBLISH_BACKOFF_MS,
  WorkspaceSettingsService,
} from '../../../src/modules/workspace-settings/index.js';
import { asUser, createWorkspace, MemoryWorkspaceStore } from '../workspaces/helpers.js';
import {
  entitlementsStub,
  MemorySettingsStore,
  settingsApp,
  settingsMessages,
  updateEvents,
  type SettingsApp,
} from './helpers.js';

const patch = (t: SettingsApp, id: string, owner: string, etag: string, payload: unknown) =>
  t.app.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${id}/settings`,
    headers: { ...asUser(owner), 'if-match': etag },
    payload: payload as Record<string, unknown>,
  });

async function setup(options: { failPublish?: boolean } = {}) {
  const t = await settingsApp({ plan: 'team', ...options });
  const owner = t.store.addUser();
  const { id } = await createWorkspace(t.app, owner);
  return { t, id, owner };
}

describe('workspace.settings_changed (acceptance 5)', () => {
  it('publishes exactly one message per change, naming only the keys that changed', async () => {
    const { t, id, owner } = await setup();
    const res = await patch(t, id, owner, '"s0"', {
      auto_approve: 'trusted',
      share_history: true,
      history_retention_days: null,
    });
    expect(res.statusCode).toBe(200);
    expect(t.published.filter((p) => p.channel === WORKSPACE_EVENTS_CHANNEL)).toHaveLength(1);
    expect(settingsMessages(t)).toEqual([
      {
        type: 'workspace.settings_changed',
        wsp: id,
        changed: ['auto_approve'],
        at: '2026-10-07T12:00:00.000Z',
      },
    ]);
    const second = await patch(t, id, owner, '"s1"', {
      share_history: false,
      history_retention_days: 30,
    });
    expect(second.statusCode).toBe(200);
    expect(settingsMessages(t).map((m) => m['changed'])).toEqual([
      ['auto_approve'],
      ['share_history', 'history_retention_days'],
    ]);
  });

  it('announces nothing for a PATCH that changes nothing, and keeps the ETag', async () => {
    const { t, id, owner } = await setup();
    const res = await patch(t, id, owner, '"s0"', { auto_approve: 'ask', share_history: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['etag']).toBe('"s0"');
    expect(settingsMessages(t)).toEqual([]);
    expect(updateEvents(t.store)).toEqual([]);
  });

  it('retries a failing publish 3 times, then logs and counts it; the change stands', async () => {
    const { t, id, owner } = await setup({ failPublish: true });
    const res = await patch(t, id, owner, '"s0"', { share_history: false });
    expect(res.statusCode).toBe(200);
    expect(t.sleeps).toEqual([
      SETTINGS_PUBLISH_BACKOFF_MS,
      SETTINGS_PUBLISH_BACKOFF_MS * 2,
      SETTINGS_PUBLISH_BACKOFF_MS * 4,
    ]);
    expect(t.recorded.count('workspace_settings_publish_failures_total')).toBe(1);
    expect(t.captured.lines()).toContainEqual(
      expect.objectContaining({ msg: 'workspace.settings_publish_failed', workspace_id: id }),
    );
    const got = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(got.json()).toMatchObject({ share_history: false });
  });

  it('stops retrying once a publish goes through', async () => {
    const store = new MemoryWorkspaceStore();
    const owner = store.addUser();
    const workspaceId = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    store.workspaces.set(workspaceId, {
      id: workspaceId,
      name: 'Acme',
      slug: 'acme',
      version: 1,
      createdAt: new Date(),
      createdBy: owner,
      deletedAt: null,
    });
    let calls = 0;
    const published: string[] = [];
    const service = new WorkspaceSettingsService({
      store: new MemorySettingsStore(store),
      entitlements: entitlementsStub('team'),
      events: {
        publish: (_channel, message) => {
          calls++;
          if (calls < 3) return Promise.reject(new Error('redis down'));
          published.push(message);
          return Promise.resolve();
        },
      },
      sleep: () => Promise.resolve(),
    });
    await service.update(
      workspaceId,
      { auto_approve: 'everyone' },
      { any: true },
      { audit: () => Promise.resolve('aud_x') },
    );
    expect(calls).toBe(3);
    expect(published).toHaveLength(1);
    expect(SETTINGS_PUBLISH_ATTEMPTS).toBe(4);
  });
});

describe('the audit event (acceptance 5)', () => {
  it('names the changed keys with their old and new values, and nothing else', async () => {
    const { t, id, owner } = await setup();
    await patch(t, id, owner, '"s0"', { auto_approve: 'everyone', history_retention_days: 14 });
    await patch(t, id, owner, '"s1"', { share_history: false, history_retention_days: null });
    const events = updateEvents(t.store);
    expect(events.map((e) => e['meta'])).toEqual([
      {
        fields: 'auto_approve,history_retention_days',
        auto_approve_from: 'ask',
        auto_approve_to: 'everyone',
        retention_days_from: null,
        retention_days_to: 14,
      },
      {
        fields: 'share_history,history_retention_days',
        share_history_from: true,
        share_history_to: false,
        retention_days_from: 14,
        retention_days_to: null,
      },
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        action: 'workspace.update',
        workspace_id: id,
        actor_id: owner,
        target_type: 'workspace',
        target_id: id,
        outcome: 'success',
      });
      // No free text: every value is a key list, an enum, a flag, a count or null.
      for (const [key, value] of Object.entries(event['meta'] as Record<string, unknown>)) {
        if (key === 'fields') {
          expect(value).toMatch(/^[a-z_]+(,[a-z_]+)*$/);
        } else if (typeof value === 'string') {
          expect(['ask', 'trusted', 'everyone']).toContain(value);
        } else {
          expect(value === null || typeof value === 'boolean' || Number.isInteger(value)).toBe(
            true,
          );
        }
      }
    }
  });

  it('writes no event for a refused change', async () => {
    const { t, id, owner } = await setup();
    expect((await patch(t, id, owner, '"s0"', { history_retention_days: 31 })).statusCode).toBe(
      422,
    );
    expect((await patch(t, id, owner, '"s9"', { share_history: false })).statusCode).toBe(412);
    expect(updateEvents(t.store)).toEqual([]);
    expect(settingsMessages(t)).toEqual([]);
  });
});
