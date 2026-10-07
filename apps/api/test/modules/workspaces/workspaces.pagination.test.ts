/**
 * Listing workspaces (B027, card test workspaces.pagination.test.ts, acceptance 3): only the
 * caller's, newest first; `limit` 50 by default and at most 200; 120 workspaces page as 50, 50
 * and 20 with no row repeated or skipped, even when workspaces are created or deleted between
 * pages; a cursor works only for the member it was made for (another's is a 400); guests see
 * `{id, name}`. Pages validate against CT-API-WORKSPACES `WorkspacePage`.
 */
import { validate } from '@centcom/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { asUser, createWorkspace, workspacesApp } from './helpers.js';

interface PageBody {
  data: { id: string; name: string; role?: string }[];
  next_cursor: string | null;
  has_more: boolean;
}

describe('GET /v1/workspaces', () => {
  it("pages 120 workspaces as 50, 50 and 20, newest first, and only the caller's (acceptance 3)", async () => {
    const { app, store } = await workspacesApp({ maxOwned: 200 });
    const user = store.addUser();
    const other = store.addUser();
    const created: string[] = [];
    for (let i = 0; i < 120; i++) created.push((await createWorkspace(app, user, `W${i}`)).id);
    await createWorkspace(app, other, 'Not yours');
    const pages: PageBody[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = cursor === null ? {} : { cursor };
      const res: LightMyRequestResponse = await app.inject({
        url: '/v1/workspaces',
        headers: asUser(user),
        query,
      });
      expect(res.statusCode).toBe(200);
      const body: PageBody = res.json<PageBody>();
      expect(validate('api/WorkspacePage', body).ok).toBe(true);
      pages.push(body);
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(pages.map((p) => p.data.length)).toEqual([50, 50, 20]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    expect(pages.flatMap((p) => p.data.map((w) => w.id))).toEqual([...created].reverse());
  });

  it('honours limit up to 200 and refuses more', async () => {
    const { app, store } = await workspacesApp({ maxOwned: 200 });
    const user = store.addUser();
    for (let i = 0; i < 5; i++) await createWorkspace(app, user, `W${i}`);
    const list = (query: Record<string, string>) =>
      app.inject({ url: '/v1/workspaces', headers: asUser(user), query });
    expect((await list({ limit: '2' })).json<PageBody>().data).toHaveLength(2);
    expect((await list({ limit: '200' })).json<PageBody>().data).toHaveLength(5);
    for (const limit of ['201', '0', 'ten']) {
      expect((await list({ limit })).statusCode, limit).toBe(422);
    }
    expect((await list({ offset: '10' })).statusCode).toBe(422);
  });

  it('keeps its place when workspaces are created or deleted between pages', async () => {
    const { app, store } = await workspacesApp({ maxOwned: 200 });
    const user = store.addUser();
    const created: string[] = [];
    for (let i = 0; i < 6; i++) created.push((await createWorkspace(app, user, `W${i}`)).id);
    const first = (
      await app.inject({ url: '/v1/workspaces', headers: asUser(user), query: { limit: '3' } })
    ).json<PageBody>();
    expect(first.data.map((w) => w.id)).toEqual([created[5], created[4], created[3]]);
    // A newer workspace appears and an unseen one goes before the next page is read.
    await createWorkspace(app, user, 'Newer');
    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${created[1] ?? ''}`,
      headers: asUser(user),
    });
    const second = (
      await app.inject({
        url: '/v1/workspaces',
        headers: asUser(user),
        query: { limit: '3', cursor: first.next_cursor ?? '' },
      })
    ).json<PageBody>();
    expect(second.data.map((w) => w.id)).toEqual([created[2], created[0]]);
    expect(second.next_cursor).toBeNull();
  });

  it("refuses a cursor made for another member's list (a different filter)", async () => {
    const { app, store } = await workspacesApp();
    const alice = store.addUser();
    const bob = store.addUser();
    for (let i = 0; i < 3; i++) {
      await createWorkspace(app, alice, `A${i}`);
      await createWorkspace(app, bob, `B${i}`);
    }
    const page = (
      await app.inject({ url: '/v1/workspaces', headers: asUser(alice), query: { limit: '1' } })
    ).json<PageBody>();
    const cursor = page.next_cursor ?? '';
    const reused = await app.inject({
      url: '/v1/workspaces',
      headers: asUser(bob),
      query: { cursor },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ code: 'cursor_invalid' });
    const tampered = await app.inject({
      url: '/v1/workspaces',
      headers: asUser(alice),
      query: { cursor: `${cursor.slice(0, -2)}xx` },
    });
    expect(tampered.statusCode).toBe(400);
  });

  it('shows a guest {id, name} of the workspaces they are a guest in', async () => {
    const { app, store } = await workspacesApp();
    const owner = store.addUser();
    const guest = store.addUser();
    const { id } = await createWorkspace(app, owner);
    store.join(id, guest, 'guest');
    const body = (
      await app.inject({ url: '/v1/workspaces', headers: asUser(guest) })
    ).json<PageBody>();
    expect(body.data).toEqual([{ id, name: 'Acme' }]);
  });
});
