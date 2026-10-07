/**
 * Listing members (B028, card test members.list.test.ts, acceptance 7): 120 members page as 50,
 * 50 and 20, oldest first, with no member repeated or skipped; owners and admins see addresses,
 * members and billing see names and roles without them, guests see `{id, display_name, role}`
 * (CT-RBAC), API keys see no addresses; a cursor from another workspace is a 400. Pages validate
 * against CT-API-WORKSPACES `MemberPage` (all but a guest's).
 */
import { validate } from '@centcom/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { arrange, asKey, asUser, membersApp } from './helpers.js';

interface PageBody {
  data: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
}

describe('GET /v1/workspaces/{id}/members', () => {
  it('pages 120 members as 50, 50 and 20, oldest first (acceptance 7)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users } = arrange(store);
    const joined = store.memberships.filter((m) => m.workspaceId === workspaceId).map((m) => m.id);
    for (let i = joined.length; i < 120; i++)
      joined.push(store.join(workspaceId, store.addUser(), 'member'));
    const pages: PageBody[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { limit: '50', ...(cursor === null ? {} : { cursor }) };
      const res: LightMyRequestResponse = await app.inject({
        url: `/v1/workspaces/${workspaceId}/members`,
        headers: asUser(users.admin),
        query,
      });
      expect(res.statusCode).toBe(200);
      const body: PageBody = res.json<PageBody>();
      expect(validate('api/MemberPage', body).ok).toBe(true);
      pages.push(body);
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(pages.map((p) => p.data.length)).toEqual([50, 50, 20]);
    expect(pages.flatMap((p) => p.data.map((m) => m['id']))).toEqual(joined);
  });

  it('shows addresses to owners and admins only, and guests {id, display_name, role} (acceptance 7)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users } = arrange(store);
    const list = async (headers: Record<string, string>) =>
      (
        await app.inject({ url: `/v1/workspaces/${workspaceId}/members`, headers })
      ).json<PageBody>();
    for (const role of ['owner', 'admin'] as const) {
      const { data } = await list(asUser(users[role]));
      expect(
        data.every((m) => typeof m['email'] === 'string'),
        role,
      ).toBe(true);
      expect(data.find((m) => m['user'] === users.member)?.['email']).toBe(
        store.profiles.get(users.member)?.email,
      );
    }
    for (const role of ['member', 'billing'] as const) {
      const body = await list(asUser(users[role]));
      expect(
        body.data.some((m) => 'email' in m),
        role,
      ).toBe(false);
      expect(validate('api/MemberPage', body).ok).toBe(true);
      expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
        'display_name',
        'id',
        'joined_at',
        'role',
        'user',
      ]);
    }
    const guest = await list(asUser(users.guest));
    expect(guest.data.map((m) => Object.keys(m).sort())).toEqual(
      Array.from({ length: 5 }, () => ['display_name', 'id', 'role']),
    );
    const byKey = await list(asKey(workspaceId));
    expect(byKey.data).toHaveLength(5);
    expect(byKey.data.some((m) => 'email' in m)).toBe(false);
    const raw = JSON.stringify(await list(asUser(users.member)));
    for (const userId of Object.values(users)) {
      expect(raw).not.toContain(store.profiles.get(userId)?.email ?? 'never');
    }
  });

  it('refuses a cursor made for another workspace, and limits above 200', async () => {
    const { app, store } = await membersApp();
    const first = arrange(store);
    const second = arrange(store);
    store.join(second.workspaceId, first.users.owner, 'member');
    const page = (
      await app.inject({
        url: `/v1/workspaces/${first.workspaceId}/members`,
        headers: asUser(first.users.owner),
        query: { limit: '1' },
      })
    ).json<PageBody>();
    const reused = await app.inject({
      url: `/v1/workspaces/${second.workspaceId}/members`,
      headers: asUser(first.users.owner),
      query: { cursor: page.next_cursor ?? '' },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ code: 'cursor_invalid' });
    const tooMany = await app.inject({
      url: `/v1/workspaces/${first.workspaceId}/members`,
      headers: asUser(first.users.owner),
      query: { limit: '201' },
    });
    expect(tooMany.statusCode).toBe(422);
  });
});
