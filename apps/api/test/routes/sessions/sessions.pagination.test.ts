/**
 * Lists and their filters (B054; test "sessions.pagination.test.ts": cursor stability and filters,
 * acceptance 9):
 *
 * - `limit` 1-200, 50 by default; 0 and 201 are 422;
 * - three pages of a workspace's sessions stay stable while sessions are created between pages
 *   (no repeat, no gap of the sessions that existed);
 * - `state` (`active`, `live`, `ended`), `mine`, `workspace`; a bad filter is 422;
 * - without `workspace` the list is the caller's own sessions, and leaves out a session whose
 *   workspace the caller has left;
 * - a cursor works only with the filters it was made for;
 * - members page by join order, and a member who left neither shows nor shifts the others' order.
 */
import { describe, expect, it } from 'vitest';
import { sessionsApp, World } from './helpers.js';

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  // The team plan allows 10 sessions at a time; ended ones do not count.
  const make = async (n: number, end = true) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const s = await env.create(w.owner, w.id, { name: `S${i}` });
      ids.push(s.id);
      if (end) {
        await env.app.inject({
          method: 'POST',
          url: `/v1/sessions/${s.id}/end`,
          headers: await env.as(w.owner),
        });
      }
    }
    return ids;
  };
  const list = async (query: string, who = w.owner) =>
    env.app.inject({ method: 'GET', url: `/v1/sessions?${query}`, headers: await env.as(who) });
  return { ...env, w, make, list };
}

type Page = {
  data: { id: string; state: string }[];
  next_cursor: string | null;
  has_more: boolean;
};

describe('GET /v1/sessions', () => {
  it('honours limit 1..200 (default 50) and refuses 0 and 201 with 422', async () => {
    const env = await setup();
    await env.make(3);
    expect((await env.list(`workspace=${env.w.id}&limit=1`)).json<Page>().data).toHaveLength(1);
    expect((await env.list(`workspace=${env.w.id}&limit=200`)).statusCode).toBe(200);
    expect((await env.list(`workspace=${env.w.id}`)).json<Page>().data).toHaveLength(3);
    for (const limit of ['0', '201', 'x']) {
      const res = await env.list(`workspace=${env.w.id}&limit=${limit}`);
      expect(res.statusCode, limit).toBe(422);
      expect(res.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/limit');
    }
  });

  it('pages stably while sessions are created between pages', async () => {
    const env = await setup();
    const existing = await env.make(6);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const res = await env.list(
        `workspace=${env.w.id}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json<Page>();
      seen.push(...body.data.map((s) => s.id));
      cursor = body.next_cursor;
      await env.make(1);
    }
    expect(seen).toEqual([...existing].reverse());
    expect(new Set(seen).size).toBe(6);
  });

  it('filters by state (active is live) and mine', async () => {
    const env = await setup();
    const ended = await env.make(2);
    const [live] = await env.make(1, false);
    const states = async (q: string) => (await env.list(q)).json<Page>().data.map((s) => s.id);
    expect(await states(`workspace=${env.w.id}&state=active`)).toEqual([live]);
    expect(await states(`workspace=${env.w.id}&state=live`)).toEqual([live]);
    expect((await states(`workspace=${env.w.id}&state=ended`)).sort()).toEqual([...ended].sort());
    // The member is in none of them: mine is empty for them, everything for the owner.
    expect(
      (await env.list(`workspace=${env.w.id}&mine=true`, env.w.member)).json<Page>().data,
    ).toEqual([]);
    expect((await env.list('mine=true')).json<Page>().data).toHaveLength(3);
    for (const bad of ['state=gone', 'mine=yes', 'workspace=nope']) {
      expect((await env.list(bad)).statusCode, bad).toBe(422);
    }
  });

  it('lists only the caller’s own sessions without a workspace, minus workspaces they left', async () => {
    const env = await setup();
    const [sid] = await env.make(1, false);
    expect((await env.list('', env.w.member)).json<Page>().data).toEqual([]);
    if (sid === undefined) throw new Error('no session');
    env.world.addMember(sid, env.w.member, 'editor');
    expect((await env.list('', env.w.member)).json<Page>().data.map((s) => s.id)).toEqual([sid]);
    env.world.memberships = env.world.memberships.filter((m) => m.userId !== env.w.member.user);
    expect((await env.list('', env.w.member)).json<Page>().data).toEqual([]);
  });

  it('refuses a cursor with other filters', async () => {
    const env = await setup();
    await env.make(3);
    const first = (await env.list(`workspace=${env.w.id}&limit=1`)).json<Page>();
    const res = await env.list(
      `workspace=${env.w.id}&state=ended&limit=1&cursor=${encodeURIComponent(String(first.next_cursor))}`,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/sessions/{id}/members', () => {
  it('pages by join order; a member who left neither shows nor shifts the order', async () => {
    const env = await setup();
    const { id: sid } = await env.create(env.w.owner, env.w.id);
    const people = Array.from({ length: 5 }, (_, i) => env.world.person(`P${i}`));
    const ids = people.map((p) => {
      env.world.memberships.push({ workspaceId: env.w.id, userId: p.user, role: 'member' });
      return env.world.addMember(sid, p, 'editor');
    });
    const left = env.world.members.find((m) => m.id === ids[1]);
    if (left !== undefined) left.leftAt = new Date(env.clock.now());
    const orders: number[] = [];
    const members: string[] = [];
    let cursor: string | null = null;
    type MembersPage = { data: { id: string; join_order: number }[]; next_cursor: string | null };
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await env.app.inject({
        method: 'GET',
        url: `/v1/sessions/${sid}/members?limit=2${after}`,
        headers: await env.as(env.w.owner),
      });
      expect(res.statusCode).toBe(200);
      const body: MembersPage = res.json<MembersPage>();
      orders.push(...body.data.map((m) => m.join_order));
      members.push(...body.data.map((m) => m.id));
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(orders).toEqual([1, 2, 4, 5, 6]);
    expect(members).not.toContain(ids[1]);
    expect(members).toHaveLength(5);
  });

  it('leaves out a member removed from the workspace, or now billing', async () => {
    const env = await setup();
    const { id: sid } = await env.create(env.w.owner, env.w.id);
    const gone = env.world.addMember(sid, env.w.member, 'editor');
    const billing = env.world.addMember(sid, env.w.billing, 'viewer');
    env.world.memberships = env.world.memberships.filter((m) => m.userId !== env.w.member.user);
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}/members`,
      headers: await env.as(env.w.owner),
    });
    const ids = res.json<{ data: { id: string }[] }>().data.map((m) => m.id);
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(billing);
    expect(ids).toHaveLength(1);
  });

  it('refuses a members cursor of another caller', async () => {
    const env = await setup();
    const { id: sid } = await env.create(env.w.owner, env.w.id);
    for (let i = 0; i < 3; i++) env.world.addMember(sid, env.world.person(), 'viewer');
    env.world.addMember(sid, env.w.member, 'editor');
    const first = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}/members?limit=1`,
      headers: await env.as(env.w.owner),
    });
    const cursor = encodeURIComponent(String(first.json<{ next_cursor: string }>().next_cursor));
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}/members?limit=1&cursor=${cursor}`,
      headers: await env.as(env.w.member),
    });
    expect(res.statusCode).toBe(400);
  });
});
