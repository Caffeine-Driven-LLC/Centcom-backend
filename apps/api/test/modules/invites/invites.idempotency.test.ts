/**
 * Idempotency of invites (B029 acceptance 1, B024): creating needs an `Idempotency-Key` (400
 * without); the same key and body replay the stored answer, token included, with
 * `Idempotency-Replayed: true` and no second invite or e-mail; the same key with another body is
 * a 409. Accepting takes a key too: a replay answers the same membership.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addUser,
  arrange,
  asInvitee,
  asUser,
  createInvite,
  invitesApp,
  type InvitesApp,
} from './helpers.js';

const post = (t: InvitesApp, workspaceId: string, userId: string, payload: object, key?: string) =>
  t.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invites`,
    headers: { ...asUser(userId), ...(key === undefined ? {} : { 'idempotency-key': key }) },
    payload,
  });

describe('creating an invite', () => {
  it('needs an Idempotency-Key: 400 idempotency_key_required, nothing created', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const res = await post(t, workspaceId, users.admin, { email: 'grace@example.test' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'idempotency_key_required' });
    expect(t.inviteStore.rows.size).toBe(0);
    expect(t.mails).toEqual([]);
    expect(t.seats.calls).toEqual([]);
  });

  it('replays the stored answer for the same key and body, creating and mailing once', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const key = randomUUID();
    const body = { email: 'grace@example.test', role: 'admin' };
    const first = await post(t, workspaceId, users.admin, body, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const again = await post(t, workspaceId, users.admin, body, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(t.inviteStore.rows.size).toBe(1);
    expect(t.mails).toHaveLength(1);
    expect(t.store.audit.filter((r) => r['action'] === 'invite.create')).toHaveLength(1);
  });

  it('is a 409 idempotency_conflict for the same key with another body', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const key = randomUUID();
    expect((await post(t, workspaceId, users.admin, { role: 'member' }, key)).statusCode).toBe(201);
    const other = await post(t, workspaceId, users.admin, { role: 'guest' }, key);
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(t.inviteStore.rows.size).toBe(1);
  });

  it('scopes keys by caller: another admin’s same key creates another invite', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const key = randomUUID();
    const mine = await createInvite(t, workspaceId, users.admin, {}, key);
    const theirs = await createInvite(t, workspaceId, users.owner, {}, key);
    expect(theirs.status).toBe(201);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.token).not.toBe(mine.token);
  });

  it('replays a refusal too (4xx answers are kept)', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    t.seats.deny = true;
    const key = randomUUID();
    expect((await post(t, workspaceId, users.admin, {}, key)).statusCode).toBe(403);
    t.seats.deny = false;
    const again = await post(t, workspaceId, users.admin, {}, key);
    expect(again.statusCode).toBe(403);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(t.inviteStore.rows.size).toBe(0);
  });
});

describe('accepting an invite', () => {
  it('takes an Idempotency-Key: the same key replays the membership; without one it still works', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const invitee = addUser(t.store);
    const key = randomUUID();
    const accept = (token: string, idempotencyKey?: string) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/invites/${token}/accept`,
        headers: {
          ...asInvitee(invitee),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
      });
    const first = await accept(created.token, key);
    expect(first.statusCode).toBe(201);
    const replay = await accept(created.token, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    // The same key for another invite is another request.
    const other = await createInvite(t, workspaceId, users.admin);
    const conflict = await accept(other.token, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
    // No key: the route still answers (the key is optional there).
    const plain = await accept(created.token);
    expect(plain.statusCode).toBe(201);
    expect(t.store.memberships.filter((m) => m.userId === invitee)).toHaveLength(1);
  });
});
