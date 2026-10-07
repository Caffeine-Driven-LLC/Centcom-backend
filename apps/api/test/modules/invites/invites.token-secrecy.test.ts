/**
 * Token secrecy (B029 acceptance 2, guardrails): the plaintext token is in the create response
 * and the invite e-mail, nowhere else. Not in the stored invites (only its sha256), the audit
 * events, the logs (which carry the route template), the invite list or the error bodies, and the
 * idempotency record of the create keeps its copy encrypted. The key of an invite link's fragment
 * (`#k=`) never reaches the server: as a `k` query parameter it is refused, and it is in no log or
 * row either way.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { storeKeyFor } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { INVITE_ROUTE_DETAILS } from '../../../src/modules/invites/index.js';
import {
  addUser,
  arrange,
  asHost,
  asInvitee,
  asUser,
  createInvite,
  invitesApp,
  sealedBundle,
} from './helpers.js';

const CREATE_ROUTE = '/v1/workspaces/:id/invites';

/** Every form a token could be written in: as given, and its bytes in hex and base64. */
const forms = (token: string): string[] => {
  const bytes = Buffer.from(token, 'base64url');
  return [token, bytes.toString('hex'), bytes.toString('base64')];
};

/** The stored invites, every byte column in hex and base64url. */
const dump = (rows: Iterable<object>): string =>
  JSON.stringify([...rows], (_key, value: unknown) => {
    if (value instanceof Buffer) return [value.toString('hex'), value.toString('base64url')];
    if (typeof value === 'object' && value !== null && 'type' in value && 'data' in value) {
      const data = (value as { data: unknown }).data;
      if (Array.isArray(data)) {
        const bytes = Buffer.from(data as number[]);
        return [bytes.toString('hex'), bytes.toString('base64url')];
      }
    }
    return value;
  });

describe('invite tokens', () => {
  it('appear in the create response and the e-mail only', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const linkKey = randomUUID();
    const link = await createInvite(t, workspaceId, users.admin, {}, linkKey);
    const mailed = await createInvite(t, workspaceId, users.admin, {
      email: 'grace@example.test',
      role: 'admin',
    });
    expect(link.status).toBe(201);
    expect(mailed.status).toBe(201);
    expect(t.mails[0]?.data.email.text).toContain(mailed.token);
    expect(t.mails[0]?.data.email.html).toContain(mailed.token);

    // Everything else an invite goes through: preview, list, a key bundle, accept, revoke.
    const host = addUser(t.store);
    t.store.join(workspaceId, host, 'member');
    t.inviteStore.hosts.push({ workspaceId, userId: host });
    const replies = [
      await t.app.inject({ url: `/v1/invites/${link.token}` }),
      await t.app.inject({
        url: `/v1/workspaces/${workspaceId}/invites`,
        headers: asUser(users.admin),
      }),
      await t.app.inject({
        method: 'PUT',
        url: `/v1/invites/${link.id}/key-bundle`,
        headers: asHost(host),
        payload: { bundle: sealedBundle().toString('base64url') },
      }),
    ];
    const invitee = addUser(t.store);
    replies.push(
      await t.app.inject({
        method: 'POST',
        url: `/v1/invites/${link.token}/accept`,
        headers: { ...asInvitee(invitee), 'idempotency-key': randomUUID() },
      }),
      await t.app.inject({
        url: `/v1/invites/${link.token}/key-bundle`,
        headers: asInvitee(invitee),
      }),
      await t.app.inject({
        url: `/v1/invites/${link.token}/key-bundle`,
        headers: asInvitee(invitee),
      }),
      await t.app.inject({ url: `/v1/invites/${link.token}` }),
      await t.app.inject({
        method: 'DELETE',
        url: `/v1/invites/${mailed.id}`,
        headers: asUser(users.admin),
      }),
      await t.app.inject({ url: `/v1/invites/${mailed.token}` }),
      await t.app.inject({
        method: 'POST',
        url: `/v1/invites/${mailed.token}/accept`,
        headers: asInvitee(addUser(t.store)),
      }),
    );
    expect(replies.map((r) => r.statusCode)).toEqual([
      200, 200, 204, 201, 200, 410, 410, 204, 410, 410,
    ]);
    await t.emitter.flush(1000);

    // The stored token is its sha256.
    for (const created of [link, mailed]) {
      const row = t.inviteStore.rows.get(created.id);
      expect(row?.tokenHash).toEqual(createHash('sha256').update(created.token, 'utf8').digest());
    }
    const record = await t.redis.kv.get(storeKeyFor(users.admin, 'POST', CREATE_ROUTE, linkKey));
    expect(record).not.toBeNull();
    const places: Record<string, string> = {
      invites: dump(t.inviteStore.rows.values()),
      audit: JSON.stringify([...t.store.audit, ...t.detached]),
      logs: t.captured.raw(),
      replies: replies.map((r) => r.body).join('\n'),
      idempotency: record ?? '',
    };
    for (const created of [link, mailed]) {
      for (const [place, text] of Object.entries(places)) {
        for (const form of forms(created.token)) expect(text, place).not.toContain(form);
      }
    }
    // The access log names routes by their template.
    expect(t.captured.access().map((l) => l['route'])).toContain('/v1/invites/:token');
    expect(t.captured.access().map((l) => l['route'])).toContain('/v1/invites/:token/accept');
  });

  it('replay the create from the idempotency record (kept encrypted) with the same token', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const key = randomUUID();
    const first = await createInvite(t, workspaceId, users.admin, {}, key);
    const again = await t.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invites`,
      headers: { ...asUser(users.admin), 'idempotency-key': key },
      payload: {},
    });
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json<{ token: string }>().token).toBe(first.token);
    const record = await t.redis.kv.get(storeKeyFor(users.admin, 'POST', CREATE_ROUTE, key));
    for (const form of forms(first.token)) expect(record).not.toContain(form);
  });
});

describe('the key in an invite link’s fragment', () => {
  it('is refused as a k query parameter (400) and reaches no log or row, nor as a fragment', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const key = randomBytes(32).toString('base64url');
    const asQuery = await t.app.inject({ url: `/v1/invites/${created.token}?k=${key}` });
    expect(asQuery.statusCode).toBe(400);
    expect(asQuery.json()).toMatchObject({
      code: 'invalid_request',
      detail: INVITE_ROUTE_DETAILS.keyInQuery,
    });
    const onAccept = await t.app.inject({
      method: 'POST',
      url: `/v1/invites/${created.token}/accept?k=${key}`,
      headers: asInvitee(addUser(t.store)),
    });
    expect(onAccept.statusCode).toBe(400);
    expect(t.inviteStore.rows.get(created.id)?.acceptedAt).toBeNull();
    // A client that sends the whole link, fragment included, leaves no trace of it either.
    const fragment = await t.app.inject({ url: `/v1/invites/${created.token}#k=${key}` });
    expect([200, 400, 404]).toContain(fragment.statusCode);
    await t.emitter.flush(1000);
    const everything = [
      t.captured.raw(),
      dump(t.inviteStore.rows.values()),
      JSON.stringify([...t.store.audit, ...t.detached]),
      asQuery.body,
      onAccept.body,
      fragment.body,
    ].join('\n');
    expect(everything).not.toContain(key);
    expect(everything).not.toContain('#k=');
  });
});
