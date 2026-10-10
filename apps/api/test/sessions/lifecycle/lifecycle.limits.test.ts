/**
 * Create and its limits (B053; tests "lifecycle.limits.test.ts", acceptance 1, 5 and the
 * entitlements failure mode):
 *
 * - create: a `ses_` id, state live, host = the creator's member (slot 0), the policy defaults, a
 *   `session.created` event and a `live` notification after the commit;
 * - 403 `entitlement_required` when `relay_access` is off (the free plan) or the workspace already
 *   has `max_concurrent_sessions` sessions that are not over; ending one makes room;
 * - entitlements failing or slower than 2 s: 503 with `retry_after_s` 5, and no row;
 * - names: 1-80 characters, NFC, no control characters;
 * - end: the host and workspace owners and admins may; editors, viewers and members may not
 *   (403 `host_required`); ending an ended session returns it unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('create and end on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(5);
  });
  afterAll(async () => {
    await test?.drop();
  });

  const input = (
    w: Awaited<ReturnType<ReturnType<typeof lifecycleOn>['seed']>>,
    name = 'Release train',
  ) => ({
    workspaceId: w.workspace,
    creatorUserId: w.owner.user,
    creatorDeviceId: w.owner.device,
    name,
    region: 'eu',
  });

  it('creates a live session hosted by its creator, then notifies', async () => {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    const s = await env.service.create({ ...input(w), policy: { auto_approve: 'everyone' } });
    expect(s.id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(s).toMatchObject({
      state: 'live',
      workspace: w.workspace,
      name: 'Release train',
      region: 'eu',
    });
    expect(s.policy).toEqual({
      auto_approve: 'everyone',
      share_history: false,
      queue_limit: 20,
      locked: false,
      auto_failover: false,
    });
    const host = await test.db
      .selectFrom('session_members')
      .select(['id', 'role', 'slot', 'user_id'])
      .where('session_id', '=', s.id)
      .executeTakeFirstOrThrow();
    expect(host).toEqual({ id: s.host, role: 'host', slot: 0, user_id: w.owner.user });
    expect(env.relayed).toEqual([{ sid: s.id, state: 'live' }]);
    expect(env.events).toEqual([
      expect.objectContaining({
        type: 'session.created',
        workspace: w.workspace,
        data: { session: s.id, host: s.host, name: 'Release train', state: 'live' },
      }),
    ]);
  });

  it('403 entitlement_required without relay_access (free plan)', async () => {
    const env = lifecycleOn(test.db, 'free');
    const w = await env.seed();
    await expect(env.service.create(input(w))).rejects.toMatchObject({
      code: 'entitlement_required',
      status: 403,
    });
  });

  it('403 entitlement_required at max_concurrent_sessions; ending one makes room', async () => {
    const env = lifecycleOn(test.db, 'pro');
    const w = await env.seed();
    const limit = env.entitlements.state.limits['max_concurrent_sessions'] as number;
    const made = [];
    for (let i = 0; i < limit; i += 1) made.push(await env.service.create(input(w, `S${i}`)));
    await expect(env.service.create(input(w))).rejects.toMatchObject({
      code: 'entitlement_required',
    });
    const first = made[0];
    if (first === undefined) return;
    await env.service.end(first.id, { userId: w.owner.user, reason: 'done' });
    expect((await env.service.create(input(w))).state).toBe('live');
  });

  for (const mode of ['fail', 'hang'] as const) {
    it(`entitlements that ${mode}: 503 with retry_after_s 5, and no row`, async () => {
      const env = lifecycleOn(test.db);
      const w = await env.seed();
      env.entitlements.state.mode = mode;
      await expect(env.service.create(input(w))).rejects.toMatchObject({
        code: 'service_unavailable',
        retryAfterS: 5,
      });
      const rows = await test.db
        .selectFrom('sessions')
        .select('id')
        .where('workspace_id', '=', w.workspace)
        .execute();
      expect(rows).toEqual([]);
    });
  }

  it('names: 1-80 characters, NFC, no control characters', async () => {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    for (const bad of ['', 'x'.repeat(81), 'bad\u0007name']) {
      await expect(env.service.create(input(w, bad))).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    const s = await env.service.create(input(w, 'Café'));
    expect(s.name).toBe('Café');
  });

  it('end: host, owner and admin may; editors, viewers and plain members may not; ended is a no-op', async () => {
    const env = lifecycleOn(test.db);
    const w = await env.seed();
    const make = () => env.service.create(input(w));
    const a = await make();
    const editor = await env.join(a.id, w.member, 'editor', 1);
    const viewer = await env.join(a.id, w.guest, 'viewer', 2);
    expect(editor).toMatch(/^mem_/);
    expect(viewer).toMatch(/^mem_/);
    for (const who of [w.member, w.guest]) {
      await expect(
        env.service.end(a.id, { userId: who.user, reason: 'done' }),
      ).rejects.toMatchObject({
        code: 'host_required',
        status: 403,
      });
    }
    expect(await env.stateOf(a.id)).toBe('live');
    const ended = await env.service.end(a.id, { userId: w.owner.user, reason: 'done' });
    expect(ended.state).toBe('ended');
    expect(ended.ended_at).not.toBeNull();
    const again = await env.service.end(a.id, { userId: w.owner.user, reason: 'abandoned' });
    expect(again).toEqual(ended);
    expect(env.events.filter((e) => e.type === 'session.ended')).toHaveLength(1);
    // A workspace admin who is not the host.
    const b = await make();
    expect((await env.service.end(b.id, { userId: w.admin.user, reason: 'error' })).state).toBe(
      'ended',
    );
  });
});
