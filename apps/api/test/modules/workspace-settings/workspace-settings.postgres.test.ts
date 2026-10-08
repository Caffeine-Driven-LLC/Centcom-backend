/**
 * Settings over Postgres 16 (B034; DATABASE_URL, CI's integration job): the routes through the SQL
 * stores, with the defaults until the first PATCH creates the row, the `settings` field of a
 * workspace PATCH, audit events written in the change's transaction, ten PATCHes with one ETag
 * racing on the real row lock (one 200), the table's constraints, and the purge: the settings row
 * holds the workspace row until `deleteForWorkspace` (the worker's hook) removes it.
 */
import { newId } from '@centcom/contracts';
import {
  createMembershipRepo,
  createWorkspaceSettingsStore,
  createWorkspaceStore,
  type WorkspaceSettingsDb,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { asUser } from '../workspaces/helpers.js';
import { buildSettingsApp } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('workspace settings on Postgres 16', () => {
  it('reads defaults, creates the row, audits, races and purges on the real database', async () => {
    const t = await migratedDatabase(12);
    try {
      const db = t.db as unknown as Kysely<WorkspaceSettingsDb>;
      const store = createWorkspaceStore(t.db);
      const settingsStore = createWorkspaceSettingsStore(db);
      const app = await buildSettingsApp(store, createMembershipRepo(t.db), settingsStore, {
        auditPool: t.db,
        plan: 'team',
      });
      const user = newId('usr');
      await t.db
        .insertInto('users')
        .values({ id: user, email: `${user.toLowerCase()}@example.test`, display_name: 'Ada' })
        .execute();
      const created = await app.app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: asUser(user),
        payload: { name: 'Acme' },
      });
      const id = String(created.json<{ id: string }>().id);

      // Defaults, then the first PATCH creates the row.
      const defaults = await app.app.inject({
        url: `/v1/workspaces/${id}/settings`,
        headers: asUser(user),
      });
      expect(defaults.json()).toEqual({
        auto_approve: 'ask',
        share_history: true,
        history_retention_days: null,
      });
      expect(defaults.headers['etag']).toBe('"s0"');
      expect(await settingsStore.get(id)).toBeNull();
      const first = await app.app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}/settings`,
        headers: { ...asUser(user), 'if-match': '"s0"' },
        payload: { auto_approve: 'trusted', history_retention_days: 30 },
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers['etag']).toBe('"s1"');
      expect(await settingsStore.get(id)).toEqual({
        autoApprove: 'trusted',
        shareHistory: true,
        retentionDays: 30,
        version: 1,
      });

      // Ten PATCHes with one ETag: the row lock lets exactly one through.
      const racers = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.app.inject({
            method: 'PATCH',
            url: `/v1/workspaces/${id}/settings`,
            headers: { ...asUser(user), 'if-match': '"s1"' },
            payload: { history_retention_days: i },
          }),
        ),
      );
      expect(racers.map((r) => r.statusCode).sort()).toEqual([200, ...Array(9).fill(412)]);
      expect((await settingsStore.get(id))?.version).toBe(2);

      // Through the workspace PATCH: the same store, one version step each.
      const viaWorkspace = await app.app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(user), 'if-match': '"v1"' },
        payload: { settings: { share_history: false } },
      });
      expect(viaWorkspace.statusCode).toBe(200);
      expect(viaWorkspace.headers['etag']).toBe('"v2"');
      expect(await settingsStore.get(id)).toMatchObject({ shareHistory: false, version: 3 });

      const events = await sql<{ action: string; meta: Record<string, unknown> }>`
        select action, meta from audit_events
        where actor_id = ${user} and action = 'workspace.update' order by created_at, id
      `.execute(t.db);
      expect(events.rows.map((r) => r.meta)).toEqual([
        {
          fields: 'auto_approve,history_retention_days',
          auto_approve_from: 'ask',
          auto_approve_to: 'trusted',
          retention_days_from: null,
          retention_days_to: 30,
        },
        expect.objectContaining({ fields: 'history_retention_days', retention_days_from: 30 }),
        { fields: 'share_history', share_history_from: true, share_history_to: false },
        { fields: 'settings' },
      ]);

      // The table refuses what the API refuses.
      const other = newId('wsp');
      await expect(
        sql`insert into workspace_settings (workspace_id) values (${other})`.execute(t.db),
      ).rejects.toThrow(/foreign key/);
      await expect(
        sql`update workspace_settings set auto_approve = 'always' where workspace_id = ${id}`.execute(
          t.db,
        ),
      ).rejects.toThrow(/check/);
      await expect(
        sql`update workspace_settings set retention_days = -1 where workspace_id = ${id}`.execute(
          t.db,
        ),
      ).rejects.toThrow(/check/);

      // Purge: a live workspace's settings stay; a deleted one's go with the hook, then the row.
      expect(await settingsStore.deleteForWorkspace(id)).toBe(0);
      const deleted = await app.app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${id}`,
        headers: asUser(user),
      });
      expect(deleted.statusCode).toBe(204);
      await expect(store.purge(id)).rejects.toThrow(/foreign key/);
      expect(await settingsStore.deleteForWorkspace(id)).toBe(1);
      expect(await settingsStore.deleteForWorkspace(id)).toBe(0);
      expect(await store.purge(id)).toEqual({ purged: true });
      await app.app.close();
    } finally {
      await t.drop();
    }
  }, 120_000);
});
