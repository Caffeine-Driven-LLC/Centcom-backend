/**
 * Member management against the CT-RBAC matrix (B028, card test members.rbac.matrix.test.ts,
 * acceptance 1-3), table-driven: every actor role × every target role × every role change and
 * removal, with the expected answer written from the contract's rules, not from the code:
 *
 * - the owner gives any role but owner to anyone but themselves; an admin gives member, billing
 *   or guest to a member, billing or guest; no one else changes roles; `owner` is never given by
 *   PATCH (422);
 * - anyone but the owner may leave (204); the owner leaving is a 409; the owner removes anyone
 *   else; an admin removes members, billing and guests but not admins or the owner (403).
 *
 * Each case runs on a fresh workspace with one member of each role; the state after it is
 * checked too. Outsiders get 404, API keys 403.
 */
import { newId } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { arrange, asKey, asUser, membersApp, rolesOf } from './helpers.js';

const ROLES = ['owner', 'admin', 'member', 'billing', 'guest'] as const;
const ASSIGNABLE = ['admin', 'member', 'billing', 'guest'] as const;
const ORDINARY: readonly WorkspaceRole[] = ['member', 'billing', 'guest'];

/** CT-RBAC: may `actor` give `to` to a member whose role is `target`? */
function mayChange(actor: WorkspaceRole, target: WorkspaceRole, to: WorkspaceRole): boolean {
  if (actor === 'owner') return target !== 'owner';
  if (actor === 'admin') return ORDINARY.includes(target) && ORDINARY.includes(to);
  return false;
}

/** CT-RBAC and the card: the answer to `actor` removing `target` (`self` when they are one). */
function removal(actor: WorkspaceRole, target: WorkspaceRole, self: boolean): number {
  if (self) return target === 'owner' ? 409 : 204;
  if (actor === 'owner') return 204;
  if (actor === 'admin') return ORDINARY.includes(target) ? 204 : 403;
  return 403;
}

describe('PATCH /v1/workspaces/{id}/members/{mem}', () => {
  const cases = ROLES.flatMap((actor) =>
    ROLES.flatMap((target) => ASSIGNABLE.map((to) => [actor, target, to] as const)),
  );

  it.each(cases)('%s giving a %s the role %s', async (actor, target, to) => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems[target]}`,
      headers: asUser(users[actor]),
      payload: { role: to },
    });
    const allowed = mayChange(actor, target, to);
    expect(res.statusCode).toBe(allowed ? 200 : 403);
    expect(rolesOf(store, workspaceId)[users[target]]).toBe(allowed ? to : target);
    if (allowed) {
      expect(res.json()).toMatchObject({ id: mems[target], user: users[target], role: to });
    } else {
      expect(res.json()).toMatchObject({ code: 'forbidden' });
    }
  });

  it('never gives owner by PATCH, and refuses unknown roles (acceptance 1)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    for (const [role, code] of [
      ['owner', 'not_allowed'],
      ['superuser', 'invalid_value'],
      [7, 'invalid_value'],
      [undefined, 'required'],
    ] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/workspaces/${workspaceId}/members/${mems.admin}`,
        headers: asUser(users.owner),
        payload: role === undefined ? {} : { role },
      });
      expect(res.statusCode, String(role)).toBe(422);
      expect(res.json<{ errors: { pointer: string; code: string }[] }>().errors[0]).toMatchObject({
        pointer: '/role',
        code,
      });
    }
    expect(rolesOf(store, workspaceId)[users.admin]).toBe('admin');
  });
});

describe('DELETE /v1/workspaces/{id}/members/{mem}', () => {
  const cases = ROLES.flatMap((actor) => ROLES.map((target) => [actor, target] as const));

  it.each(cases)('%s removing a %s (acceptance 2, 3)', async (actor, target) => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const self = actor === target;
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems[target]}`,
      headers: asUser(users[actor]),
    });
    const expected = removal(actor, target, self);
    expect(res.statusCode).toBe(expected);
    expect(users[target] in rolesOf(store, workspaceId)).toBe(expected !== 204);
    if (expected === 409) expect(res.json()).toMatchObject({ code: 'conflict' });
  });

  it('lets the owner leave once ownership is transferred (acceptance 2)', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const transfer = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
      headers: asUser(users.owner),
      payload: { to_member: mems.admin },
    });
    expect(transfer.statusCode).toBe(200);
    const leave = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.owner}`,
      headers: asUser(users.owner),
    });
    expect(leave.statusCode).toBe(204);
    expect(rolesOf(store, workspaceId)).toEqual({
      [users.admin]: 'owner',
      [users.member]: 'member',
      [users.billing]: 'billing',
      [users.guest]: 'guest',
    });
  });
});

describe('who may ask at all', () => {
  it('answers 404 to outsiders and for unknown members, and 403 to API keys', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const outsider = store.addUser();
    for (const [method, url, payload] of [
      ['GET', `/v1/workspaces/${workspaceId}/members`, undefined],
      ['PATCH', `/v1/workspaces/${workspaceId}/members/${mems.member}`, { role: 'guest' }],
      ['DELETE', `/v1/workspaces/${workspaceId}/members/${mems.member}`, undefined],
      ['POST', `/v1/workspaces/${workspaceId}/transfer-ownership`, { to_member: mems.admin }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: asUser(outsider),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Unknown, malformed, and a member of another workspace: all 404.
    const elsewhere = arrange(store).mems.member;
    for (const memberId of [newId('mem'), 'mem_nope', elsewhere]) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/members/${memberId}`,
        headers: asUser(users.owner),
      });
      expect(res.statusCode).toBe(404);
    }
    const key = asKey(workspaceId);
    const byKey = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: key,
      payload: { role: 'guest' },
    });
    expect(byKey.statusCode).toBe(403);
    const removeByKey = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${mems.member}`,
      headers: key,
    });
    expect(removeByKey.statusCode).toBe(403);
    expect((await app.inject({ url: `/v1/workspaces/${workspaceId}/members` })).statusCode).toBe(
      401,
    );
  });
});
