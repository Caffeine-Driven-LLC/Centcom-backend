/**
 * Workspace routes over Postgres 16 (B027; DATABASE_URL, CI's integration job): create, read,
 * rename and delete through the SQL store and B021's Postgres membership reader, each audit event
 * written in the transaction of its change, then the purge. The other route tests run over the
 * in-memory store, which has the same semantics.
 */
import { newId } from '@centcom/contracts';
import { createMembershipRepo, createWorkspaceStore } from '@centcom/db';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { asUser, buildWorkspacesApp } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('workspace routes on Postgres 16', () => {
  it('creates, reads, renames and deletes, with audit events in the same transactions', async () => {
    const t = await migratedDatabase(5);
    try {
      const store = createWorkspaceStore(t.db);
      const { app } = await buildWorkspacesApp(store, createMembershipRepo(t.db), {
        auditPool: t.db,
      });
      const user = newId('usr');
      await t.db
        .insertInto('users')
        .values({ id: user, email: `${user.toLowerCase()}@example.test`, display_name: 'Ada' })
        .execute();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: asUser(user),
        payload: { name: 'Acme' },
      });
      expect(created.statusCode).toBe(201);
      const id = String(created.json<{ id: string }>().id);
      const got = await app.inject({ url: `/v1/workspaces/${id}`, headers: asUser(user) });
      expect(got.json()).toMatchObject({ id, role: 'owner', owner: user, member_count: 1 });
      expect(got.headers['etag']).toBe('"v1"');
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(user), 'if-match': '"v1"' },
        payload: { name: 'Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.headers['etag']).toBe('"v2"');
      const stale = await app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${id}`,
        headers: { ...asUser(user), 'if-match': '"v1"' },
        payload: { name: 'Again' },
      });
      expect(stale.statusCode).toBe(412);
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${id}`,
        headers: asUser(user),
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        (await app.inject({ url: `/v1/workspaces/${id}`, headers: asUser(user) })).statusCode,
      ).toBe(404);
      const events = await sql<{ action: string; workspace_id: string | null }>`
        select action, workspace_id from audit_events where actor_id = ${user} order by created_at, id
      `.execute(t.db);
      expect(events.rows).toEqual([
        { action: 'workspace.create', workspace_id: id },
        { action: 'workspace.update', workspace_id: id },
        { action: 'workspace.delete', workspace_id: null },
      ]);
      expect(await store.purge(id)).toEqual({ purged: true });
      const left = await sql<{ action: string }>`
        select action from audit_events where actor_id = ${user}
      `.execute(t.db);
      expect(left.rows).toEqual([{ action: 'workspace.delete' }]);
      await app.close();
    } finally {
      await t.drop();
    }
  }, 60_000);
});
