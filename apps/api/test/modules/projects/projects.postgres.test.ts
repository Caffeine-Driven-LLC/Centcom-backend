/**
 * Projects over Postgres 16 (B035; DATABASE_URL, CI's integration job): the routes over the SQL
 * stores and B021's Postgres membership reader, through create (and its idempotent replay), list,
 * rename with If-Match, the RBAC refusals and delete; 10 concurrent creates of one name against
 * the database's unique index make exactly one project and 409s, never a 500 (failure mode 1);
 * and after the workspace is deleted, the purge hook's call leaves no project row and lets
 * B027's purge through (acceptance 6).
 */
import { randomUUID } from 'node:crypto';
import { newId, validate } from '@centcom/contracts';
import {
  createMembershipRepo,
  createProjectStore,
  createWorkspaceStore,
  type ProjectDatabase,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { ProjectService, projectRoutes } from '../../../src/modules/projects/index.js';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { buildWorkspacesApp, KEYS } from '../workspaces/helpers.js';
import { asUser, headersOf } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('projects on Postgres 16', () => {
  it('run over the SQL stores, give one of 10 racing creates the name, and go with the workspace', async () => {
    const t = await migratedDatabase(20);
    try {
      const db = t.db as unknown as Kysely<ProjectDatabase>;
      const workspaces = createWorkspaceStore(t.db);
      const store = createProjectStore(db);
      const service = new ProjectService({ store });
      const { app } = await buildWorkspacesApp(workspaces, createMembershipRepo(t.db), {
        auditPool: t.db,
        beforeReady: async (server) => {
          await server.register(projectRoutes, { service, cursorKeys: KEYS });
        },
      });
      const addUser = async (): Promise<string> => {
        const id = newId('usr');
        await t.db
          .insertInto('users')
          .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Ada' })
          .execute();
        return id;
      };
      const join = async (
        workspaceId: string,
        userId: string,
        role: 'admin' | 'member' | 'guest',
      ) =>
        t.db
          .insertInto('memberships')
          .values({ id: newId('mem'), workspace_id: workspaceId, user_id: userId, role })
          .execute();
      const count = async (workspaceId: string): Promise<number> => {
        const rows = await sql<{ n: string }>`
          select count(*) as n from projects where workspace_id = ${workspaceId}
        `.execute(t.db);
        return Number(rows.rows[0]?.n);
      };

      const owner = await addUser();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: asUser(owner),
        payload: { name: 'Acme' },
      });
      const workspaceId = String(created.json<{ id: string }>().id);
      const member = await addUser();
      const guest = await addUser();
      await join(workspaceId, member, 'member');
      await join(workspaceId, guest, 'guest');
      const url = `/v1/workspaces/${workspaceId}/projects`;

      // Create, and replay with the same key.
      const key = randomUUID();
      const first = await app.inject({
        method: 'POST',
        url,
        headers: headersOf(member, key),
        payload: { name: 'Api', repo: 'github.com/acme/app' },
      });
      expect(first.statusCode).toBe(201);
      expect(first.headers['etag']).toBe('"v1"');
      const project = first.json<{ id: string; repo: string }>();
      expect(validate('api/Project', project).ok).toBe(true);
      const replay = await app.inject({
        method: 'POST',
        url,
        headers: headersOf(member, key),
        payload: { name: 'Api', repo: 'github.com/acme/app' },
      });
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json()).toEqual(project);
      expect(await count(workspaceId)).toBe(1);

      // The guest may not; another case of the name is taken; list.
      const refused = await app.inject({
        method: 'POST',
        url,
        headers: headersOf(guest),
        payload: { name: 'Web' },
      });
      expect(refused.statusCode).toBe(403);
      const clash = await app.inject({
        method: 'POST',
        url,
        headers: headersOf(owner),
        payload: { name: 'API' },
      });
      expect(clash.statusCode).toBe(409);
      const listed = await app.inject({ method: 'GET', url, headers: headersOf(member) });
      expect(listed.statusCode).toBe(200);
      expect(validate('api/ProjectPage', listed.json()).ok).toBe(true);
      expect(listed.json()).toEqual({ data: [project], next_cursor: null, has_more: false });

      // Rename with If-Match; the old ETag is then stale.
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${project.id}`,
        headers: { ...headersOf(member), 'if-match': '"v1"' },
        payload: { name: 'Gateway', repo: null },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.headers['etag']).toBe('"v2"');
      expect(renamed.json()).toMatchObject({ name: 'Gateway', repo: null });
      const stale = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${project.id}`,
        headers: { ...headersOf(member), 'if-match': '"v1"' },
        payload: { name: 'Late' },
      });
      expect(stale.statusCode).toBe(412);

      // Audited in the change's transaction.
      const audited = await sql<{ action: string; target_type: string; meta: unknown }>`
        select action, target_type, meta from audit_events
        where target_id = ${project.id} order by created_at, id
      `.execute(t.db);
      expect(audited.rows.map((r) => r.action)).toEqual(['workspace.update', 'workspace.update']);
      expect(audited.rows.every((r) => r.target_type === 'project')).toBe(true);

      // Delete: a member may not, the owner may.
      const memberDelete = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${project.id}`,
        headers: headersOf(member),
      });
      expect(memberDelete.statusCode).toBe(403);
      const ownerDelete = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${project.id}`,
        headers: headersOf(owner),
      });
      expect(ownerDelete.statusCode).toBe(204);
      expect(await count(workspaceId)).toBe(0);

      // 10 creates of one name race against the unique index: one 201, nine 409, no 500.
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          app.inject({
            method: 'POST',
            url,
            headers: headersOf(i % 2 === 0 ? member : owner),
            payload: { name: i % 3 === 0 ? 'race' : 'RACE' },
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, ...Array<number>(9).fill(409)]);
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: headersOf(member),
          payload: { name: `P${i}` },
        });
        expect(res.statusCode).toBe(201);
      }
      expect(await count(workspaceId)).toBe(5);

      // The workspace goes: its projects are hidden at once, then the purge hook removes them all.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}`,
        headers: asUser(owner),
      });
      expect(deleted.statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url, headers: headersOf(owner) })).statusCode).toBe(
        404,
      );
      // The foreign key restricts: B027's purge is refused while projects remain.
      await expect(workspaces.purge(workspaceId)).rejects.toMatchObject({ code: '23503' });
      // What @centcom/worker's `projects` hook calls before the purge.
      expect(await service.deleteForWorkspace(workspaceId)).toBe(5);
      expect(await count(workspaceId)).toBe(0);
      expect(await workspaces.purge(workspaceId)).toEqual({ purged: true });
      await app.close();
    } finally {
      await t.drop();
    }
  }, 120_000);
});
