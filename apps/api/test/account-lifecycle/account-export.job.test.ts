/**
 * The export runner (B026; tests "account-export.job.test.ts"), over the in-memory store and
 * object store:
 *
 * - the golden document for a seeded user, and a negative grep over it: no other user's e-mail, no
 *   `refresh`, `secret`, `sha256(` or `ct` value (acceptance 5);
 * - an upload failure is retried; on the last attempt the export is `failed` with
 *   `storage_unavailable` and no file is left behind (failure modes);
 * - the sweep expires ready exports after 7 days and deletes their files, and requeues exports
 *   still pending after 5 minutes (acceptance 6).
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  AccountExportRunner,
  buildExportDocument,
  EXPORT_FORMAT,
  exportBlobKey,
  type ExportData,
} from '../../src/modules/account-lifecycle/index.js';
import { DAY_MS, MemoryLifecycleStore, T0, memoryBlobStore } from './helpers.js';

const NOW = new Date(T0);

/** A user with one of everything, and a teammate whose data must never appear. */
function seeded(store: MemoryLifecycleStore) {
  const user = store.addUser({
    email: 'grace@example.test',
    display_name: 'Grace',
    created_at: new Date(T0 - 10 * DAY_MS),
  });
  const teammate = store.addUser({ email: 'teammate@example.test', display_name: 'Tom' });
  const workspaceId = newId('wsp');
  const data: Partial<ExportData> = {
    devices: [
      {
        id: newId('dev'),
        name: 'Laptop',
        platform: 'macos',
        fingerprint: 'ABCD-EFGH-IJKL',
        created_at: new Date(T0 - DAY_MS),
        last_seen_at: null,
        revoked_at: null,
      },
    ],
    memberships: [
      { id: newId('mem'), workspace_id: workspaceId, role: 'owner', created_at: new Date(T0) },
    ],
    apiKeys: [
      {
        id: newId('key'),
        workspace_id: workspaceId,
        name: 'CI',
        mode: 'live',
        prefix: 'cen_live_AbC',
        scope: 'sessions:read',
        created_at: new Date(T0),
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ],
    notificationPreferences: { channels: { email: true } },
    auditEvents: [
      {
        id: newId('aud'),
        workspace_id: workspaceId,
        action: 'member.role_change',
        target_type: 'membership',
        target_id: newId('mem'),
        outcome: 'success',
        created_at: new Date(T0),
      },
    ],
  };
  store.data.set(user.id, data);
  return { user, teammate, data };
}

async function createExport(store: MemoryLifecycleStore, userId: string, at = NOW) {
  const id = newId('exp');
  await store.createExport({ id, userId, createdAt: at }, new Date(0), () => Promise.resolve());
  return id;
}

describe('account-export runner', () => {
  it('writes the golden document of the user, and nothing of anyone else (acceptance 5)', async () => {
    const store = new MemoryLifecycleStore();
    const blobs = memoryBlobStore();
    const { user, teammate, data } = seeded(store);
    const id = await createExport(store, user.id);
    const runner = new AccountExportRunner({ store, blobs: blobs.store, clock: () => T0 });

    expect(await runner.run(id, { finalAttempt: false })).toBe('ready');
    const key = exportBlobKey(user.id, id);
    expect(key).toBe(`exports/${user.id}/${id}.json`);
    const text = new TextDecoder().decode(blobs.objects.get(key));
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc).toEqual({
      format: EXPORT_FORMAT,
      version: 1,
      exported_at: NOW.toISOString(),
      profile: {
        id: user.id,
        email: 'grace@example.test',
        display_name: 'Grace',
        locale: 'en',
        avatar: null,
        telemetry: false,
        created_at: new Date(T0 - 10 * DAY_MS).toISOString(),
        deletion_scheduled_for: null,
        status: 'active',
      },
      devices: [
        {
          id: data.devices?.[0]?.id,
          name: 'Laptop',
          platform: 'macos',
          fingerprint: 'ABCD-EFGH-IJKL',
          created_at: new Date(T0 - DAY_MS).toISOString(),
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      memberships: [
        {
          id: data.memberships?.[0]?.id,
          workspace_id: data.memberships?.[0]?.workspace_id,
          role: 'owner',
          created_at: NOW.toISOString(),
        },
      ],
      api_keys: [
        {
          id: data.apiKeys?.[0]?.id,
          workspace_id: data.apiKeys?.[0]?.workspace_id,
          name: 'CI',
          mode: 'live',
          prefix: 'cen_live_AbC',
          scope: 'sessions:read',
          created_at: NOW.toISOString(),
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
      notification_preferences: { channels: { email: true } },
      audit_events: [
        {
          id: data.auditEvents?.[0]?.id,
          workspace_id: data.auditEvents?.[0]?.workspace_id,
          action: 'member.role_change',
          target_type: 'membership',
          target_id: data.auditEvents?.[0]?.target_id,
          outcome: 'success',
          created_at: NOW.toISOString(),
        },
      ],
      audit_events_truncated: false,
    });
    // Negative grep (card tests): nobody else's e-mail, no token, secret, digest or ciphertext.
    expect(text).not.toContain(teammate.email);
    for (const forbidden of ['refresh', 'secret', 'sha256(', '"ct"', 'key_hash', 'token']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    const row = store.exports.get(id);
    expect(row).toMatchObject({ status: 'ready', blobKey: key, sizeBytes: text.length });
    expect(row?.expiresAt?.getTime()).toBe(T0 + 7 * DAY_MS);
    // Running it again (a duplicate delivery) does nothing.
    expect(await runner.run(id, { finalAttempt: false })).toBe('skipped');
  });

  it('says when the audit events were cut at the limit', () => {
    const store = new MemoryLifecycleStore();
    const user = store.addUser();
    const event = {
      id: newId('aud'),
      workspace_id: null,
      action: 'workspace.create',
      target_type: null,
      target_id: null,
      outcome: 'success',
      created_at: NOW,
    };
    const doc = buildExportDocument(
      {
        user,
        devices: [],
        memberships: [],
        apiKeys: [],
        notificationPreferences: null,
        auditEvents: [event, { ...event, id: newId('aud') }, { ...event, id: newId('aud') }],
      },
      NOW,
      2,
    );
    expect(doc.audit_events).toHaveLength(2);
    expect(doc.audit_events_truncated).toBe(true);
  });

  it('retries a failed upload and fails the export on the last attempt, leaving no file', async () => {
    const store = new MemoryLifecycleStore();
    const blobs = memoryBlobStore();
    const { user } = seeded(store);
    const id = await createExport(store, user.id);
    const runner = new AccountExportRunner({ store, blobs: blobs.store, clock: () => T0 });
    blobs.state.failPuts = 2;

    await expect(runner.run(id, { finalAttempt: false })).rejects.toThrow('export upload failed');
    expect(store.exports.get(id)?.status).toBe('running');
    await expect(runner.run(id, { finalAttempt: true })).rejects.toThrow('export upload failed');
    expect(store.exports.get(id)).toMatchObject({
      status: 'failed',
      errorCode: 'storage_unavailable',
    });
    expect(blobs.objects.size).toBe(0);
    expect(blobs.state.deletes).toEqual([exportBlobKey(user.id, id)]);
  });

  it('fails with `internal` when building fails on the last attempt', async () => {
    const store = new MemoryLifecycleStore();
    const blobs = memoryBlobStore();
    const { user } = seeded(store);
    const id = await createExport(store, user.id);
    const runner = new AccountExportRunner({ store, blobs: blobs.store, clock: () => T0 });
    store.exportData = () => Promise.reject(new Error('boom'));
    await expect(runner.run(id, { finalAttempt: true })).rejects.toThrow('boom');
    expect(store.exports.get(id)).toMatchObject({ status: 'failed', errorCode: 'internal' });
  });

  it('fails the export of a user who is gone', async () => {
    const store = new MemoryLifecycleStore();
    const blobs = memoryBlobStore();
    const { user } = seeded(store);
    const id = await createExport(store, user.id);
    store.users.delete(user.id);
    const runner = new AccountExportRunner({ store, blobs: blobs.store, clock: () => T0 });
    expect(await runner.run(id, { finalAttempt: false })).toBe('skipped');
    expect(store.exports.get(id)).toMatchObject({ status: 'failed', errorCode: 'account_gone' });
  });

  it('expires ready exports after 7 days and requeues stuck ones (acceptance 6)', async () => {
    const store = new MemoryLifecycleStore();
    const blobs = memoryBlobStore();
    const { user } = seeded(store);
    const other = store.addUser({ email: 'zed@example.test' });
    const id = await createExport(store, user.id);
    let now = T0;
    const runner = new AccountExportRunner({ store, blobs: blobs.store, clock: () => now });
    await runner.run(id, { finalAttempt: false });
    const stuck = await createExport(store, other.id, new Date(T0));

    now = T0 + 6 * DAY_MS;
    expect(await runner.sweep(new Date(now))).toEqual({ expired: 0, stale: [stuck] });
    expect(store.exports.get(id)?.status).toBe('ready');

    now = T0 + 7 * DAY_MS;
    expect((await runner.sweep(new Date(now))).expired).toBe(1);
    expect(store.exports.get(id)?.status).toBe('expired');
    expect(blobs.objects.size).toBe(0);
    expect(blobs.state.deletes).toEqual([exportBlobKey(user.id, id)]);
    // A second sweep finds nothing more.
    expect((await runner.sweep(new Date(now))).expired).toBe(0);
  });
});
