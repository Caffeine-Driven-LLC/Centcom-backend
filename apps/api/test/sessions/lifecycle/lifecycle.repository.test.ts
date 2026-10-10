/**
 * Listing (B053; tests "lifecycle.repository.test.ts", acceptance 8): by workspace, state and
 * "mine", newest first (ULID desc), paged by cursor; 3 pages of 50 stay stable and never repeat a
 * session even when new sessions are created between pages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('listing on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(5);
  });
  afterAll(async () => {
    await test?.drop();
  });

  it('3 pages of 50, newest first, stable while sessions are created between pages', async () => {
    const env = lifecycleOn(test.db);
    env.entitlements.state.limits['max_concurrent_sessions'] = null;
    const w = await env.seed();
    const create = (name: string) =>
      env.service.create({
        workspaceId: w.workspace,
        creatorUserId: w.owner.user,
        creatorDeviceId: w.owner.device,
        name,
        region: 'eu',
      });
    const made: string[] = [];
    for (let i = 0; i < 150; i += 1) made.push((await create(`S${i}`)).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await env.service.list({
        workspace: w.workspace,
        state: 'live',
        limit: 50,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.data).toHaveLength(50);
      seen.push(...result.data.map((s) => s.id));
      // New sessions between pages sort before the cursor and never show up later.
      await create(`late${page}`);
      cursor = result.next_cursor ?? undefined;
      if (page < 2) expect(result.has_more).toBe(true);
    }
    expect(new Set(seen).size).toBe(150);
    expect(seen).toEqual([...made].sort().reverse());
  });

  it('filters by state and by the sessions the user is a member of', async () => {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    const base = {
      workspaceId: w.workspace,
      creatorUserId: w.owner.user,
      creatorDeviceId: w.owner.device,
      region: 'eu',
    };
    const a = await env.service.create({ ...base, name: 'A' });
    const b = await env.service.create({ ...base, name: 'B' });
    await env.join(b.id, w.member, 'editor', 1);
    await env.service.end(a.id, { userId: w.owner.user, reason: 'done' });
    const ended = await env.service.list({ workspace: w.workspace, state: 'ended', limit: 50 });
    expect(ended.data.map((s) => s.id)).toEqual([a.id]);
    const mine = await env.service.list({
      workspace: w.workspace,
      mineUserId: w.member.user,
      limit: 50,
    });
    expect(mine.data.map((s) => s.id)).toEqual([b.id]);
    const owners = await env.service.list({
      workspace: w.workspace,
      mineUserId: w.owner.user,
      limit: 50,
    });
    expect(owners.data.map((s) => s.id)).toEqual([b.id, a.id]);
  });
});
