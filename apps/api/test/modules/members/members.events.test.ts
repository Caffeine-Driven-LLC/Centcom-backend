/**
 * What member changes leave behind (B028, card test members.events.test.ts, acceptance 4-6, 8):
 * after each change, a `centcom:membership` message (role_changed, removed, left; a transfer sends
 * two) published after the commit, before the answer, and an audit event with the actor, the
 * target membership and the outcome; refused attempts are audited as `denied` (RBAC's denials as
 * `permission.denied`, the owner rules' as the action itself). Transfers: atomic, idempotent
 * replays, 409 for the loser of two, 422 for a non-admin target. A publish that keeps failing is
 * retried 3 times, then counted and logged; `getLive` sees a change at once and cached roles are
 * dropped.
 */
import { newId, validate } from '@centcom/contracts';
import {
  AUDIT_BATCH_INTERVAL_MS,
  MEMBERSHIP_EVENTS_CHANNEL,
  RBAC_INVALIDATE_CHANNEL,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  announceMembershipChanges,
  MEMBER_DETAILS,
  PUBLISH_RETRIES,
} from '../../../src/modules/members/index.js';
import { recordingMetrics } from '../../helpers.js';
import { arrange, asUser, membersApp, rolesOf } from './helpers.js';

const at = expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string;

describe('a role change', () => {
  it('is announced after the commit and audited with the actor, target and outcome (acceptance 6)', async () => {
    const { app, store, membershipEvents, published } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: asUser(users.admin),
      payload: { role: 'billing' },
    });
    expect(res.statusCode).toBe(200);
    expect(validate('api/Member', res.json()).ok).toBe(true);
    // Published before the answer: well within the card's 100 ms.
    expect(membershipEvents()).toEqual([
      {
        type: 'role_changed',
        wsp: workspaceId,
        mem: mems.member,
        user: users.member,
        role: 'billing',
        at,
      },
    ]);
    expect(published.map((p) => p.channel)).toEqual([
      MEMBERSHIP_EVENTS_CHANNEL,
      RBAC_INVALIDATE_CHANNEL,
    ]);
    expect(store.audit).toEqual([
      expect.objectContaining({
        action: 'member.role_change',
        outcome: 'success',
        actor_id: users.admin,
        workspace_id: workspaceId,
        target_type: 'membership',
        target_id: mems.member,
        request_id: res.headers['x-request-id'],
        meta: JSON.stringify({ user_id: users.member, from_role: 'member', to_role: 'billing' }),
      }),
    ]);
  });

  it('to the same role changes nothing and announces nothing', async () => {
    const { app, store, membershipEvents } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems.guest}`,
      headers: asUser(users.owner),
      payload: { role: 'guest' },
    });
    expect(res.statusCode).toBe(200);
    expect(membershipEvents()).toEqual([]);
    expect(store.audit).toEqual([]);
  });

  it('is seen by getLive at once, and drops the cached role (acceptance 8)', async () => {
    const { app, store, members, published } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: asUser(users.owner),
      payload: { role: 'admin' },
    });
    expect((await members.getLive(workspaceId, users.member))?.role).toBe('admin');
    const dropped = published.find((p) => p.channel === RBAC_INVALIDATE_CHANNEL);
    expect(JSON.parse(dropped?.message ?? '{}')).toEqual({ workspaceId, userId: users.member });
    expect(await members.getLive(workspaceId, store.addUser())).toBeNull();
  });
});

describe('a removal', () => {
  it('is announced as removed or left, and audited (acceptance 6)', async () => {
    const { app, store, membershipEvents } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.guest}`,
      headers: asUser(users.admin),
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.billing}`,
      headers: asUser(users.billing),
    });
    expect(membershipEvents()).toEqual([
      { type: 'removed', wsp: workspaceId, mem: mems.guest, user: users.guest, at },
      { type: 'left', wsp: workspaceId, mem: mems.billing, user: users.billing, at },
    ]);
    expect(store.audit.map((r) => [r['action'], r['actor_id'], r['target_id'], r['meta']])).toEqual(
      [
        [
          'member.remove',
          users.admin,
          mems.guest,
          JSON.stringify({ user_id: users.guest, role: 'guest', self: false }),
        ],
        [
          'member.remove',
          users.billing,
          mems.billing,
          JSON.stringify({ user_id: users.billing, role: 'billing', self: true }),
        ],
      ],
    );
  });

  it('of a member removed meanwhile is a 404, with no success audited', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const first = app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: asUser(users.owner),
    });
    const second = app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: asUser(users.admin),
    });
    const statuses = (await Promise.all([first, second])).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([204, 404]);
    expect(store.audit.filter((r) => r['outcome'] === 'success')).toHaveLength(1);
  });
});

describe('refused attempts', () => {
  it('are audited as denied: RBAC refusals and the owner rules (acceptance 6)', async () => {
    const { app, store, emitter, detached } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems.owner}`,
      headers: asUser(users.admin),
      payload: { role: 'member' },
    });
    expect(denied.statusCode).toBe(403);
    const leave = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.owner}`,
      headers: asUser(users.owner),
    });
    expect(leave.statusCode).toBe(409);
    expect(leave.json()).toMatchObject({ detail: MEMBER_DETAILS.ownerStays });
    const toMember = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: asUser(users.owner),
      payload: { to_member: mems.member },
    });
    expect(toMember.statusCode).toBe(422);
    await emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(detached.map((r) => [r['action'], r['outcome'], r['actor_id']])).toEqual([
      ['permission.denied', 'denied', users.admin],
      ['member.remove', 'denied', users.owner],
      ['member.role_change', 'denied', users.owner],
    ]);
    expect(JSON.parse(String(detached[0]?.['meta']))).toMatchObject({
      attempted: 'member.role.change',
    });
    expect(store.audit).toEqual([]);
  });
});

describe('transfer-ownership', () => {
  it('swaps owner and admin atomically and answers with the workspace (acceptance 4)', async () => {
    const { app, store, membershipEvents } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: asUser(users.owner),
      payload: { to_member: mems.admin },
    });
    expect(res.statusCode).toBe(200);
    expect(validate('api/Workspace', res.json()).ok).toBe(true);
    expect(res.json()).toMatchObject({ id: workspaceId, role: 'admin', owner: users.admin });
    expect(rolesOf(store, workspaceId)).toMatchObject({
      [users.owner]: 'admin',
      [users.admin]: 'owner',
    });
    expect(membershipEvents()).toEqual([
      {
        type: 'role_changed',
        wsp: workspaceId,
        mem: mems.owner,
        user: users.owner,
        role: 'admin',
        at,
      },
      {
        type: 'role_changed',
        wsp: workspaceId,
        mem: mems.admin,
        user: users.admin,
        role: 'owner',
        at,
      },
    ]);
    expect(store.audit.map((r) => r['meta'])).toEqual([
      JSON.stringify({ user_id: users.owner, from_role: 'owner', to_role: 'admin' }),
      JSON.stringify({ user_id: users.admin, from_role: 'admin', to_role: 'owner' }),
    ]);
  });

  it('replays the same Idempotency-Key with the stored answer (acceptance 5)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const request = {
      method: 'POST' as const,
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: { ...asUser(users.owner), 'idempotency-key': newId('req').slice(4) },
      payload: { to_member: mems.admin },
    };
    const first = await app.inject(request);
    const again = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toBe(first.body);
    expect(store.audit).toHaveLength(2);
  });

  it('lets one of two concurrent transfers win; the other gets 409 (acceptance 4)', async () => {
    const { app, store, memberStore } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const second = store.addUser();
    const secondMem = store.join(workspaceId, second, 'admin');
    const transfer = (to: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
        headers: asUser(users.owner),
        payload: { to_member: to },
      });
    // Both pass RBAC as the owner before either transaction runs: a true race.
    let release = (): void => undefined;
    memberStore.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = Promise.all([transfer(mems.admin), transfer(secondMem)]);
    for (let i = 0; i < 200 && memberStore.waiting < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(memberStore.waiting).toBe(2);
    memberStore.gate = undefined;
    release();
    const results = await racing;
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      detail: MEMBER_DETAILS.notOwner,
    });
    const owners = Object.values(rolesOf(store, workspaceId)).filter((r) => r === 'owner');
    expect(owners).toHaveLength(1);
  });

  it('refuses a non-admin target (422), an unknown one (404) and anyone but the owner (403)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const transfer = (userId: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
        headers: asUser(userId),
        payload,
      });
    for (const role of ['member', 'billing', 'guest'] as const) {
      expect((await transfer(users.owner, { to_member: mems[role] })).statusCode, role).toBe(422);
    }
    expect((await transfer(users.owner, { to_member: mems.owner })).statusCode).toBe(422);
    expect((await transfer(users.owner, { to_member: newId('mem') })).statusCode).toBe(404);
    expect((await transfer(users.owner, { to_member: 'someone' })).statusCode).toBe(422);
    expect((await transfer(users.owner, {})).statusCode).toBe(422);
    expect((await transfer(users.admin, { to_member: mems.admin })).statusCode).toBe(403);
    expect(rolesOf(store, workspaceId)[users.owner]).toBe('owner');
  });
});

describe('the service', () => {
  it('refuses a change when the member changed since the caller read them (409)', async () => {
    const { store, members } = await membersApp();
    const { workspaceId, mems } = arrange(store);
    const ctx = { audit: () => Promise.resolve('aud') };
    await expect(
      members.changeRole(workspaceId, mems.admin, 'guest', 'member', ctx),
    ).rejects.toMatchObject({
      code: 'conflict',
      detail: MEMBER_DETAILS.changed,
    });
    await expect(
      members.remove(workspaceId, mems.admin, 'member', false, ctx),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      members.changeRole(workspaceId, newId('mem'), 'guest', 'member', ctx),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      members.changeRole(workspaceId, mems.owner, 'admin', 'owner', ctx),
    ).rejects.toMatchObject({
      detail: MEMBER_DETAILS.ownerStays,
    });
  });

  it('never removes the owner, whatever it is told', async () => {
    const { store, members } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const ctx = { audit: () => Promise.resolve('aud') };
    await expect(
      members.remove(workspaceId, mems.owner, 'owner', false, ctx),
    ).rejects.toMatchObject({ code: 'conflict', detail: MEMBER_DETAILS.ownerStays });
    expect(rolesOf(store, workspaceId)[users.owner]).toBe('owner');
  });

  it('retries a deadlocked transfer once, then answers 409', async () => {
    const { store, members, memberStore } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const ctx = { audit: () => Promise.resolve('aud') };
    const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
    memberStore.failNext.push(deadlock());
    await members.transferOwnership(workspaceId, mems.admin, users.owner, ctx);
    expect(rolesOf(store, workspaceId)[users.admin]).toBe('owner');
    memberStore.failNext.push(deadlock(), deadlock());
    await expect(
      members.transferOwnership(workspaceId, mems.owner, users.admin, ctx),
    ).rejects.toMatchObject({ code: 'conflict', detail: MEMBER_DETAILS.busy });
    memberStore.failNext.push(new Error('other'));
    await expect(
      members.transferOwnership(workspaceId, mems.owner, users.admin, ctx),
    ).rejects.toThrow('other');
  });

  it('adds a member in a transaction it is given, once (for invites, B029)', async () => {
    const { store, members, memberStore } = await membersApp();
    const { workspaceId } = arrange(store);
    const newcomer = store.addUser();
    const audited: unknown[] = [];
    const ctx = {
      audit: (_trx: unknown, input: unknown) => {
        audited.push(input);
        return Promise.resolve('aud');
      },
    };
    const added = await memberStore.transaction((tx) =>
      members.add(tx, workspaceId, newcomer, 'member', ctx),
    );
    expect(added).toMatchObject({ workspaceId, userId: newcomer, role: 'member' });
    expect(audited).toEqual([
      expect.objectContaining({
        action: 'member.add',
        meta: { user_id: newcomer, role: 'member', via: 'invite' },
      }),
    ]);
    await expect(
      memberStore.transaction((tx) => members.add(tx, workspaceId, newcomer, 'guest', ctx)),
    ).rejects.toMatchObject({ code: 'member_exists' });
  });
});

describe('announcing', () => {
  it('retries a publish up to 3 times with jitter, and stops at the first success', async () => {
    const recorded = recordingMetrics();
    const waits: number[] = [];
    let calls = 0;
    let failures = 2;
    const events = {
      publish: () => {
        calls += 1;
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('redis down'));
        }
        return Promise.resolve();
      },
      subscribe: () => Promise.resolve(() => Promise.resolve()),
    };
    const event = {
      type: 'left' as const,
      wsp: newId('wsp'),
      mem: newId('mem'),
      user: newId('usr'),
      at: new Date(0).toISOString(),
    };
    const deps = {
      events,
      metrics: recorded.metrics,
      random: () => 1,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
    await announceMembershipChanges(deps, [event]);
    // Two failures, then the message; then the invalidation at once.
    expect(calls).toBe(4);
    expect(waits).toEqual([20, 40]);
    expect(
      recorded.count('membership_event_publish_failed_total', {
        channel: MEMBERSHIP_EVENTS_CHANNEL,
      }),
    ).toBe(0);
    calls = 0;
    waits.length = 0;
    failures = 100;
    await announceMembershipChanges(deps, [event]);
    // 1 + 3 retries for the message, then the same for the invalidation.
    expect(calls).toBe(8);
    expect(waits).toEqual([20, 40, 80, 20, 40, 80]);
    expect(
      recorded.count('membership_event_publish_failed_total', {
        channel: MEMBERSHIP_EVENTS_CHANNEL,
      }),
    ).toBe(1);
  });

  it('retries a failing publish 3 times, then counts and logs it; the change stands (failure mode)', async () => {
    const { app, store, recorded, captured } = await membersApp({ failPublish: true });
    const { workspaceId, users, mems } = arrange(store);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.guest}`,
      headers: asUser(users.owner),
    });
    expect(res.statusCode).toBe(204);
    expect(users.guest in rolesOf(store, workspaceId)).toBe(false);
    expect(PUBLISH_RETRIES).toBe(3);
    expect(
      recorded.count('membership_event_publish_failed_total', {
        channel: MEMBERSHIP_EVENTS_CHANNEL,
      }),
    ).toBe(1);
    const lines = captured.lines().map((l) => l['msg']);
    expect(lines).toContain('membership.publish_failed');
    expect(lines).toContain('membership.invalidate_failed');
  });
});
