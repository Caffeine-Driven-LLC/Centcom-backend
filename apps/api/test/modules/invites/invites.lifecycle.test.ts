/**
 * Invites end to end on the API's plugin stack (B029, CT-API-WORKSPACES), with a fake clock:
 * creating (by address or link) and listing, the public preview, accepting (acceptance 4),
 * revoking (acceptance 8) and expiry at `expires_at` exactly (acceptance 6). Every answer is
 * checked against the contract's schemas; the expected statuses come from the card and the
 * contract, not from the code.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { newId, validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  INVITE_DETAILS,
  INVITE_ROUTE_DETAILS,
  INVITE_TTL_MS,
} from '../../../src/modules/invites/index.js';
import {
  addUser,
  arrange,
  asInvitee,
  asKey,
  asUser,
  createInvite,
  invitesApp,
  T0,
  type InvitesApp,
} from './helpers.js';

const preview = (t: InvitesApp, token: string) => t.app.inject({ url: `/v1/invites/${token}` });
const accept = (t: InvitesApp, token: string, userId: string) =>
  t.app.inject({
    method: 'POST',
    url: `/v1/invites/${token}/accept`,
    headers: asInvitee(userId),
  });
const revoke = (t: InvitesApp, inviteId: string, userId: string) =>
  t.app.inject({ method: 'DELETE', url: `/v1/invites/${inviteId}`, headers: asUser(userId) });
const list = (
  t: InvitesApp,
  workspaceId: string,
  userId: string,
  query: Record<string, string> = {},
) => t.app.inject({ url: `/v1/workspaces/${workspaceId}/invites`, query, headers: asUser(userId) });
const DAY_MS = 24 * 60 * 60 * 1000;

describe('creating invites', () => {
  it('by address: 201 with the token and link, the address lower-cased, 7 days, the e-mail queued', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, {
      email: 'Grace@Example.TEST',
      role: 'billing',
    });
    expect(created.status).toBe(201);
    expect(validate('api/InviteCreated', created.body).ok).toBe(true);
    expect(created.body).toEqual({
      id: created.id,
      workspace: workspaceId,
      email: 'grace@example.test',
      role: 'billing',
      status: 'pending',
      share_history: true,
      created_by: users.admin,
      created_at: new Date(T0).toISOString(),
      expires_at: new Date(T0 + 7 * DAY_MS).toISOString(),
      token: created.token,
      url: `https://app.centcom.test/i/${created.token}`,
    });
    expect(INVITE_TTL_MS).toBe(7 * DAY_MS);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{27}$/);
    // B032's workspace_invite, queued after the commit, once per invite.
    expect(t.mails).toHaveLength(1);
    const mail = t.mails[0];
    expect(mail?.data.template).toBe('workspace_invite');
    expect(mail?.data.email).toMatchObject({ to: 'grace@example.test' });
    expect(mail?.data.email.text).toContain(`https://app.centcom.test/i/${created.token}`);
    expect(mail?.data.email.text).toContain('Acme');
    expect(mail?.opts).toMatchObject({ attempts: 5 });
    expect(t.store.audit).toEqual([
      expect.objectContaining({
        action: 'invite.create',
        outcome: 'success',
        actor_id: users.admin,
        workspace_id: workspaceId,
        target_type: 'invite',
        target_id: created.id,
        meta: JSON.stringify({ role: 'billing', kind: 'email' }),
      }),
    ]);
    // The seat gate was asked inside the transaction (B030).
    expect(t.seats.calls).toEqual([{ workspaceId, inTransaction: true }]);
  });

  it('by link: no address, member by default, share_history as asked, no e-mail', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.owner, { share_history: false });
    expect(created.status).toBe(201);
    expect(validate('api/InviteCreated', created.body).ok).toBe(true);
    expect(created.body).toMatchObject({ email: null, role: 'member', share_history: false });
    expect(t.mails).toEqual([]);
    expect(t.store.audit[0]?.['meta']).toBe(JSON.stringify({ role: 'member', kind: 'link' }));
    // Every invite has its own token.
    const other = await createInvite(t, workspaceId, users.owner);
    expect(other.token).not.toBe(created.token);
  });

  it('needs admin or owner: 403 for member, billing, guest and API keys, 404 for outsiders', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    for (const role of ['member', 'billing', 'guest'] as const) {
      const res = await createInvite(t, workspaceId, users[role]);
      expect(res.status, role).toBe(403);
    }
    expect((await createInvite(t, workspaceId, addUser(t.store))).status).toBe(404);
    const keyed = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: { ...asKey(newId('wsp')), 'idempotency-key': randomUUID() },
      payload: {},
    });
    // API keys never invite (CT-RBAC gives member.invite no key scope), whichever workspace.
    expect(keyed.statusCode).toBe(403);
    const ownKey = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: { ...asKey(workspaceId), 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(ownKey.statusCode).toBe(403);
    const readOnly = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: { ...asUser(users.owner, 'workspaces:read'), 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(readOnly.statusCode).toBe(403);
    expect(t.inviteStore.rows.size).toBe(0);
  });

  it('refuses bad bodies with 422 and the pointers, without echoing them', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const bad = await createInvite(t, workspaceId, users.owner, {
      email: 'not an address',
      role: 'owner',
      share_history: 'yes',
    });
    expect(bad.status).toBe(422);
    const pointers = (bad.body['errors'] as { pointer: string }[]).map((e) => e.pointer);
    expect(pointers).toEqual(['/email', '/role', '/share_history']);
    expect(JSON.stringify(bad.body)).not.toContain('not an address');
    expect((await createInvite(t, workspaceId, users.owner, { email: 42 })).status).toBe(422);
    const notObject = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: {
        ...asUser(users.owner),
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      payload: '[]',
    });
    expect(notObject.statusCode).toBe(422);
    expect(t.inviteStore.rows.size).toBe(0);
  });

  it('keeps one pending invite per address (409, no id), replaces a lapsed one, refuses members', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const first = await createInvite(t, workspaceId, users.admin, { email: 'grace@example.test' });
    const again = await createInvite(t, workspaceId, users.owner, { email: 'GRACE@example.test' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'conflict', detail: INVITE_DETAILS.pendingExists });
    expect(JSON.stringify(again.body)).not.toContain(first.id);
    // Another workspace may invite the same address.
    const other = arrange(t.store);
    const elsewhere = await createInvite(t, other.workspaceId, other.users.owner, {
      email: 'grace@example.test',
    });
    expect(elsewhere.status).toBe(201);
    // A lapsed invite no longer blocks a new one.
    t.clock.now = T0 + 7 * DAY_MS;
    const renewed = await createInvite(t, workspaceId, users.admin, {
      email: 'grace@example.test',
    });
    expect(renewed.status).toBe(201);
    expect(t.inviteStore.rows.get(first.id)?.expiredAt).toEqual(new Date(T0 + 7 * DAY_MS));
    // An address that belongs to a member: 409 member_exists.
    const memberEmail = t.store.profiles.get(users.member)?.email ?? '';
    const member = await createInvite(t, workspaceId, users.admin, { email: memberEmail });
    expect(member.status).toBe(409);
    expect(member.body).toMatchObject({ code: 'member_exists' });
  });

  it('refuses when the seat gate does (403, entitlement family) and creates nothing', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    t.seats.seats = 5;
    const full = await createInvite(t, workspaceId, users.admin, { email: 'grace@example.test' });
    expect(full.status).toBe(403);
    expect(full.body).toMatchObject({ code: 'seat_limit_reached' });
    t.seats.seats = Number.POSITIVE_INFINITY;
    t.seats.deny = true;
    const denied = await createInvite(t, workspaceId, users.admin);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'entitlement_required' });
    expect(t.inviteStore.rows.size).toBe(0);
    expect(t.mails).toEqual([]);
    expect(t.store.audit).toEqual([]);
  });

  it('stands when its e-mail cannot be queued: logged and counted, no delivery claim', async () => {
    const t = await invitesApp({ failMail: true });
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, {
      email: 'grace@example.test',
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body)).not.toContain('delivery');
    expect(t.inviteStore.rows.has(created.id)).toBe(true);
    expect(t.recorded.count('invite_mail_failures_total')).toBe(1);
    expect(t.captured.lines()).toContainEqual(
      expect.objectContaining({ msg: 'invite.mail_failed', invite_id: created.id }),
    );
  });

  it('lists pending invites oldest first, by keyset pages, without tokens (admin+)', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      t.clock.now = T0 + i * 1000;
      ids.push((await createInvite(t, workspaceId, users.admin)).id);
    }
    // Neither a revoked nor an accepted invite is pending.
    const gone = await createInvite(t, workspaceId, users.admin);
    expect((await revoke(t, gone.id, users.owner)).statusCode).toBe(204);
    const used = await createInvite(t, workspaceId, users.admin);
    expect((await accept(t, used.token, addUser(t.store))).statusCode).toBe(201);
    const first = await list(t, workspaceId, users.admin, { limit: '3' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    const page = first.json<{ data: Record<string, unknown>[]; next_cursor: string | null }>();
    expect(validate('api/InvitePage', page).ok).toBe(true);
    expect(page.data.map((i) => i['id'])).toEqual(ids.slice(0, 3));
    expect(page.data.every((i) => !('token' in i) && !('url' in i))).toBe(true);
    expect(page.next_cursor).toEqual(expect.any(String));
    const second = await list(t, workspaceId, users.admin, {
      limit: '3',
      cursor: page.next_cursor ?? '',
    });
    expect(second.json<{ data: { id: string }[] }>().data.map((i) => i.id)).toEqual(ids.slice(3));
    // Expired invites drop out at their expiry.
    t.clock.now = T0 + 7 * DAY_MS;
    const later = await list(t, workspaceId, users.owner);
    expect(later.json<{ data: { id: string }[] }>().data.map((i) => i.id)).toEqual(ids.slice(1));
    // A cursor belongs to its workspace.
    const other = arrange(t.store);
    const foreign = await list(t, other.workspaceId, other.users.owner, {
      cursor: page.next_cursor ?? '',
    });
    expect(foreign.statusCode).toBe(400);
    expect((await list(t, workspaceId, users.member)).statusCode).toBe(403);
    expect((await list(t, workspaceId, addUser(t.store))).statusCode).toBe(404);
  });
});

describe('the preview', () => {
  it('shows the workspace name, inviter, role, expiry and whether a key bundle waits, no more', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, { role: 'guest' });
    const res = await preview(t, created.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<Record<string, unknown>>();
    expect(validate('api/InvitePreview', body).ok).toBe(true);
    expect(body).toEqual({
      workspace_name: 'Acme',
      inviter_name: t.store.profiles.get(users.admin)?.displayName,
      role: 'guest',
      expires_at: new Date(T0 + 7 * DAY_MS).toISOString(),
      has_key_bundle: false,
    });
  });

  it('is 404 for an unknown or malformed token and 410 once expired, revoked or used', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const unknown = await preview(t, randomBytes(20).toString('base64url'));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      code: 'invite_invalid',
      detail: INVITE_DETAILS.unknown,
    });
    expect((await preview(t, 'not-a-token')).statusCode).toBe(404);
    expect((await preview(t, 'A'.repeat(64))).statusCode).toBe(404);

    const expiring = await createInvite(t, workspaceId, users.admin);
    t.clock.now = T0 + 7 * DAY_MS - 1000;
    expect((await preview(t, expiring.token)).statusCode).toBe(200);
    t.clock.now = T0 + 7 * DAY_MS;
    const expired = await preview(t, expiring.token);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ code: 'invite_expired' });

    t.clock.now = T0;
    const revoked = await createInvite(t, workspaceId, users.admin);
    await revoke(t, revoked.id, users.admin);
    const afterRevoke = await preview(t, revoked.token);
    expect(afterRevoke.statusCode).toBe(410);
    expect(afterRevoke.json()).toMatchObject({ code: 'invite_revoked' });

    const used = await createInvite(t, workspaceId, users.admin);
    await accept(t, used.token, addUser(t.store));
    const afterUse = await preview(t, used.token);
    expect(afterUse.statusCode).toBe(410);
    expect(afterUse.json()).toMatchObject({ code: 'gone', detail: INVITE_DETAILS.used });
  });

  it('is 404 once the workspace is deleted', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const ws = t.store.workspaces.get(workspaceId);
    if (ws !== undefined) ws.deletedAt = new Date(T0);
    expect((await preview(t, created.token)).statusCode).toBe(404);
    expect((await accept(t, created.token, addUser(t.store))).statusCode).toBe(404);
  });
});

describe('accepting', () => {
  it('makes one membership with the invite’s role, answers the workspace and member, audits both', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, { role: 'billing' });
    const invitee = addUser(t.store);
    t.clock.now = T0 + 60_000;
    const res = await accept(t, created.token, invitee);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{
      workspace: Record<string, unknown>;
      member: Record<string, unknown>;
    }>();
    expect(validate('api/InviteAcceptance', body).ok).toBe(true);
    expect(body.workspace).toMatchObject({ id: workspaceId, name: 'Acme', role: 'billing' });
    expect(body.member).toMatchObject({ user: invitee, role: 'billing' });
    const mine = t.store.memberships.filter((m) => m.userId === invitee);
    expect(mine).toEqual([expect.objectContaining({ workspaceId, role: 'billing' })]);
    expect(body.member['id']).toBe(mine[0]?.id);
    expect(t.inviteStore.rows.get(created.id)).toMatchObject({
      acceptedAt: new Date(T0 + 60_000),
      acceptedBy: invitee,
    });
    expect(t.store.audit.slice(1).map((r) => [r['action'], r['actor_id'], r['meta']])).toEqual([
      ['member.add', invitee, JSON.stringify({ user_id: invitee, role: 'billing', via: 'invite' })],
      ['invite.accept', invitee, JSON.stringify({ user_id: invitee, role: 'billing' })],
    ]);
    expect(t.recorded.count('invites_accepted_total')).toBe(1);
    // The seat gate was asked in the accepting transaction too.
    expect(t.seats.calls.at(-1)).toEqual({ workspaceId, inTransaction: true });
  });

  it('gives the same membership to the same user again, and 410 to anyone else', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const invitee = addUser(t.store);
    const first = await accept(t, created.token, invitee);
    const again = await accept(t, created.token, invitee);
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.json<{ member: unknown }>().member).toEqual(
      first.json<{ member: unknown }>().member,
    );
    const other = await accept(t, created.token, addUser(t.store));
    expect(other.statusCode).toBe(410);
    expect(other.json()).toMatchObject({ code: 'gone' });
    expect(t.store.memberships.filter((m) => m.workspaceId === workspaceId)).toHaveLength(6);
    expect(t.recorded.count('invites_accepted_total')).toBe(1);
    // A user who left gets no membership back from a used invite.
    t.store.memberships = t.store.memberships.filter((m) => m.userId !== invitee);
    expect((await accept(t, created.token, invitee)).statusCode).toBe(410);
  });

  it('binds an e-mail invite to its address: another address gets 403 and no membership', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, {
      email: 'grace@example.test',
    });
    const stranger = addUser(t.store, 'mallory@example.test');
    const refused = await accept(t, created.token, stranger);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'forbidden',
      detail: INVITE_DETAILS.otherAddress,
    });
    expect(JSON.stringify(refused.json())).not.toContain('grace@');
    expect(t.store.memberships.some((m) => m.userId === stranger)).toBe(false);
    const grace = addUser(t.store, 'grace@example.test');
    expect((await accept(t, created.token, grace)).statusCode).toBe(201);
  });

  it('is 410 at expires_at + 1 s, and 409 for a user who already is a member', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const member = await accept(t, created.token, users.member);
    expect(member.statusCode).toBe(409);
    expect(member.json()).toMatchObject({ code: 'member_exists' });
    expect(t.inviteStore.rows.get(created.id)?.acceptedAt).toBeNull();
    t.clock.now = T0 + 7 * DAY_MS + 1000;
    const late = await accept(t, created.token, addUser(t.store));
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ code: 'invite_expired' });
  });

  it('needs a signed-in user with the profile scope: 401 anonymous, 403 for keys and other scopes', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const url = `/v1/invites/${created.token}/accept`;
    expect((await t.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    const key = await t.app.inject({ method: 'POST', url, headers: asKey(workspaceId, 'profile') });
    expect(key.statusCode).toBe(403);
    expect(key.json()).toMatchObject({ detail: INVITE_ROUTE_DETAILS.usersOnly });
    const scoped = await t.app.inject({ method: 'POST', url, headers: asUser(addUser(t.store)) });
    expect(scoped.statusCode).toBe(403);
    expect((await accept(t, 'short', addUser(t.store))).statusCode).toBe(404);
    expect(t.inviteStore.rows.get(created.id)?.acceptedAt).toBeNull();
  });
});

describe('revoking', () => {
  it('is 204 for an admin, then the preview and accept are 410 and the invite is not listed', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, {
      email: 'grace@example.test',
    });
    t.clock.now = T0 + 5000;
    const res = await revoke(t, created.id, users.admin);
    expect(res.statusCode).toBe(204);
    expect(t.inviteStore.rows.get(created.id)?.revokedAt).toEqual(new Date(T0 + 5000));
    expect((await preview(t, created.token)).json()).toMatchObject({ code: 'invite_revoked' });
    const grace = addUser(t.store, 'grace@example.test');
    expect((await accept(t, created.token, grace)).statusCode).toBe(410);
    expect((await list(t, workspaceId, users.admin)).json<{ data: unknown[] }>().data).toEqual([]);
    expect(t.store.audit.at(-1)).toMatchObject({
      action: 'invite.revoke',
      actor_id: users.admin,
      target_id: created.id,
      meta: '{}',
    });
    // The address may be invited again.
    expect(
      (await createInvite(t, workspaceId, users.admin, { email: 'grace@example.test' })).status,
    ).toBe(201);
  });

  it('is 403 for a member, 404 for outsiders and unknown ids, 410 for an invite already done', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const byMember = await revoke(t, created.id, users.member);
    expect(byMember.statusCode).toBe(403);
    expect((await revoke(t, created.id, addUser(t.store))).statusCode).toBe(404);
    expect((await revoke(t, newId('inv'), users.admin)).statusCode).toBe(404);
    expect((await revoke(t, 'inv_nope', users.admin)).statusCode).toBe(404);
    expect(t.inviteStore.rows.get(created.id)?.revokedAt).toBeNull();
    expect((await revoke(t, created.id, users.owner)).statusCode).toBe(204);
    const twice = await revoke(t, created.id, users.owner);
    expect(twice.statusCode).toBe(410);
    expect(twice.json()).toMatchObject({ code: 'invite_revoked' });
    const used = await createInvite(t, workspaceId, users.admin);
    await accept(t, used.token, addUser(t.store));
    expect((await revoke(t, used.id, users.owner)).statusCode).toBe(410);
  });
});

describe('expiry', () => {
  it('is exactly at expires_at; the sweep marks lapsed invites expired', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    expect(await t.inviteStore.sweep(new Date(T0 + 7 * DAY_MS - 1))).toEqual({
      expired: 0,
      bundlesDropped: 0,
    });
    expect(await t.inviteStore.sweep(new Date(T0 + 7 * DAY_MS))).toEqual({
      expired: 1,
      bundlesDropped: 0,
    });
    expect(t.inviteStore.rows.get(created.id)?.expiredAt).toEqual(new Date(T0 + 7 * DAY_MS));
    // An expired invite stays expired, whatever the clock says.
    t.clock.now = T0;
    expect((await preview(t, created.token)).json()).toMatchObject({ code: 'invite_expired' });
  });
});

describe('starting', () => {
  it('fails without the seatGate decorator (B030): seat checks are never skipped', async () => {
    await expect(invitesApp({ withoutSeatGate: true })).rejects.toThrow(
      INVITE_ROUTE_DETAILS.missingSeatGate,
    );
  });
});
