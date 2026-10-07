/**
 * Members over Postgres 16 (B028; DATABASE_URL, CI's integration job): the routes over the SQL
 * stores and B021's Postgres membership reader, each audit event in its change's transaction;
 * and the owner invariant under real concurrency: 50 transfers and removals at once leave
 * exactly one owner (acceptance 4; card test members.owner-invariant.test.ts against the
 * database's locks).
 */
import { newId } from '@centcom/contracts';
import { createMemberStore, createMembershipRepo, createWorkspaceStore } from '@centcom/db';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { MembershipService, memberRoutes } from '../../../src/modules/members/index.js';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { buildWorkspacesApp, KEYS } from '../workspaces/helpers.js';
import { asUser } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('members on Postgres 16', () => {
  it('manages members over the SQL stores and keeps one owner through 50 concurrent attempts', async () => {
    const t = await migratedDatabase(20);
    try {
      const workspaces = createWorkspaceStore(t.db);
      const memberStore = createMemberStore(t.db);
      const { app } = await buildWorkspacesApp(workspaces, createMembershipRepo(t.db), {
        auditPool: t.db,
        beforeReady: async (server, ctx) => {
          const members = new MembershipService({
            store: memberStore,
            events: ctx.events,
            sleep: () => Promise.resolve(),
          });
          await server.register(memberRoutes, { members, workspaces, cursorKeys: KEYS });
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
      const owner = await addUser();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: asUser(owner),
        payload: { name: 'Acme' },
      });
      const workspaceId = String(created.json<{ id: string }>().id);
      const admins: { user: string; mem: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const user = await addUser();
        const mem = newId('mem');
        await t.db
          .insertInto('memberships')
          .values({ id: mem, workspace_id: workspaceId, user_id: user, role: 'admin' })
          .execute();
        admins.push({ user, mem });
      }
      const member = await addUser();
      const memberMem = newId('mem');
      await t.db
        .insertInto('memberships')
        .values({ id: memberMem, workspace_id: workspaceId, user_id: member, role: 'member' })
        .execute();

      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${workspaceId}/members/${memberMem}`,
        headers: asUser(owner),
        payload: { role: 'billing' },
      });
      expect(patched.statusCode).toBe(200);
      const list = await app.inject({
        url: `/v1/workspaces/${workspaceId}/members`,
        headers: asUser(owner),
      });
      expect(list.json<{ data: { email?: string }[] }>().data.every((m) => m.email)).toBe(true);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/members/${memberMem}`,
        headers: asUser(owner),
      });
      expect(removed.statusCode).toBe(204);
      const ownerMem = (await memberStore.getLive(workspaceId, owner))?.id ?? '';

      const everyone = [owner, ...admins.map((a) => a.user)];
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => {
          const actor = everyone[i % everyone.length] ?? owner;
          const target = admins[(i * 7) % admins.length]?.mem ?? '';
          return i % 5 === 4
            ? app.inject({
                method: 'DELETE',
                url: `/v1/workspaces/${workspaceId}/members/${ownerMem}`,
                headers: asUser(actor),
              })
            : app.inject({
                method: 'POST',
                url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
                headers: asUser(actor),
                payload: { to_member: target },
              });
        }),
      );
      for (const res of results) expect([200, 204, 403, 404, 409, 422]).toContain(res.statusCode);
      const owners = await sql<{ n: string }>`
        select count(*) as n from memberships where workspace_id = ${workspaceId} and role = 'owner'
      `.execute(t.db);
      expect(Number(owners.rows[0]?.n)).toBe(1);
      const audited = await sql<{ action: string }>`
        select action from audit_events where workspace_id = ${workspaceId}
      `.execute(t.db);
      const actions = audited.rows.map((r) => r.action);
      expect(actions).toContain('member.role_change');
      expect(actions).toContain('member.remove');
      await app.close();
    } finally {
      await t.drop();
    }
  }, 120_000);
});
