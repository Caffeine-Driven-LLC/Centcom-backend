/**
 * Listing projects (B035, card test projects.pagination.test.ts, acceptance 5): 120 projects with
 * `limit=50` page as 50, 50 and 20, oldest first, with `has_more` true, true, false and no row
 * repeated or skipped, even when projects are created between pages; a cursor works only for the
 * workspace it was made for. Pages validate against CT-API-WORKSPACES `ProjectPage`.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { arrange, createProject, headersOf, projectsApp, type ProjectsApp } from './helpers.js';

interface PageBody {
  data: { id: string; name: string }[];
  next_cursor: string | null;
  has_more: boolean;
}

const page = async (
  t: ProjectsApp,
  workspaceId: string,
  userId: string,
  query: Record<string, string>,
): Promise<{ status: number; body: PageBody }> => {
  const res = await t.app.inject({
    url: `/v1/workspaces/${workspaceId}/projects`,
    headers: headersOf(userId),
    query,
  });
  return { status: res.statusCode, body: res.json<PageBody>() };
};

describe('GET /v1/workspaces/{id}/projects', () => {
  it('pages 120 projects with limit=50 as 50, 50 and 20, stably (acceptance 5)', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const other = arrange(t.store);
    const created: string[] = [];
    for (let i = 0; i < 120; i++) {
      created.push((await createProject(t.app, workspaceId, users.member, { name: `P${i}` })).id);
    }
    await createProject(t.app, other.workspaceId, other.users.member, { name: 'Not yours' });
    const pages: PageBody[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { limit: '50', ...(cursor === null ? {} : { cursor }) };
      const { status, body } = await page(t, workspaceId, users.member, query);
      expect(status).toBe(200);
      expect(validate('api/ProjectPage', body).ok).toBe(true);
      pages.push(body);
      cursor = body.next_cursor;
      // Created between pages: after every row already listed, so nothing shifts.
      if (pages.length === 1) {
        created.push((await createProject(t.app, workspaceId, users.admin, { name: 'Late' })).id);
      }
    } while (cursor !== null);
    expect(pages.map((p) => p.data.length)).toEqual([50, 50, 21]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    expect(pages.flatMap((p) => p.data.map((d) => d.id))).toEqual(created);
  });

  it('is the same order on every read', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    for (let i = 0; i < 7; i++) await createProject(t.app, workspaceId, users.member);
    const first = await page(t, workspaceId, users.member, { limit: '3' });
    const again = await page(t, workspaceId, users.owner, { limit: '3' });
    expect(again.body.data).toEqual(first.body.data);
  });

  it('refuses a cursor made for another workspace with a 400', async () => {
    const t = await projectsApp();
    const a = arrange(t.store);
    const b = arrange(t.store);
    // One user in both workspaces, so only the cursor's binding differs.
    t.store.join(b.workspaceId, a.users.member, 'member');
    for (let i = 0; i < 3; i++) await createProject(t.app, a.workspaceId, a.users.member);
    const first = await page(t, a.workspaceId, a.users.member, { limit: '2' });
    const cursor = first.body.next_cursor ?? '';
    expect(cursor).not.toBe('');
    const res = await page(t, b.workspaceId, a.users.member, { limit: '2', cursor });
    expect(res.status).toBe(400);
  });

  it('honours limit up to 200 and refuses more, less or junk with 422', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    for (let i = 0; i < 3; i++) await createProject(t.app, workspaceId, users.member);
    expect((await page(t, workspaceId, users.member, { limit: '200' })).body.data).toHaveLength(3);
    for (const limit of ['201', '0', 'ten']) {
      expect((await page(t, workspaceId, users.member, { limit })).status, limit).toBe(422);
    }
  });
});
