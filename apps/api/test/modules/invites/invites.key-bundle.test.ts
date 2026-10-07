/**
 * Invite key bundles (B029 acceptance 7, CT-CRYPTO §4): a session host of the workspace stores a
 * sealed bundle (opaque base64url, at least the 48 bytes of a sealed box's overhead, at most
 * 16 KiB of text: 413 beyond); anyone else gets 403. The user who accepted the invite fetches it
 * once, then 410; the token alone is not enough. The bundle goes on revocation, at the invite's
 * expiry (the sweep, every 5 minutes) and 15 minutes after acceptance if never fetched. It is
 * never logged.
 */
import { randomBytes } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  INVITE_DETAILS,
  KEY_BUNDLE_AFTER_ACCEPT_MS,
  MAX_KEY_BUNDLE_CHARS,
  MIN_KEY_BUNDLE_BYTES,
} from '../../../src/modules/invites/index.js';
import {
  addUser,
  arrange,
  asHost,
  asInvitee,
  asUser,
  createInvite,
  invitesApp,
  sealedBundle,
  T0,
  type InvitesApp,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A workspace with a host of one of its sessions, and a link invite in it. */
async function setUp(): Promise<{
  t: InvitesApp;
  workspaceId: string;
  users: ReturnType<typeof arrange>['users'];
  host: string;
  invite: { id: string; token: string };
}> {
  const t = await invitesApp();
  const { workspaceId, users } = arrange(t.store);
  const host = users.member;
  t.inviteStore.hosts.push({ workspaceId, userId: host });
  const invite = await createInvite(t, workspaceId, users.admin);
  return { t, workspaceId, users, host, invite };
}

const put = (t: InvitesApp, inviteId: string, userId: string, payload: unknown) =>
  t.app.inject({
    method: 'PUT',
    url: `/v1/invites/${inviteId}/key-bundle`,
    headers: asHost(userId),
    payload: payload as Record<string, unknown>,
  });
const take = (t: InvitesApp, token: string, userId: string) =>
  t.app.inject({ url: `/v1/invites/${token}/key-bundle`, headers: asInvitee(userId) });
const accept = (t: InvitesApp, token: string, userId: string) =>
  t.app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: asInvitee(userId) });
const base64url = (bytes: Buffer): { bundle: string } => ({ bundle: bytes.toString('base64url') });

describe('storing a key bundle', () => {
  it('takes a sealed-box-shaped blob from a session host: 204, then the preview shows it', async () => {
    const { t, host, invite } = await setUp();
    // crypto_box_seal: a 32-byte ephemeral key, the sealed keys, a 16-byte MAC (CT-CRYPTO).
    const sealed = Buffer.concat([randomBytes(32), randomBytes(96), randomBytes(16)]);
    expect(validate('api/KeyBundle', base64url(sealed)).ok).toBe(true);
    expect((await put(t, invite.id, host, base64url(sealed))).statusCode).toBe(204);
    expect(t.inviteStore.rows.get(invite.id)?.keyBundle).toEqual(sealed);
    const preview = await t.app.inject({ url: `/v1/invites/${invite.token}` });
    expect(preview.json()).toMatchObject({ has_key_bundle: true });
    // Until the invite expires; a second upload replaces the first.
    expect(t.inviteStore.rows.get(invite.id)?.keyBundleExpiresAt).toEqual(
      new Date(T0 + 7 * DAY_MS),
    );
    const newer = sealedBundle(10);
    expect((await put(t, invite.id, host, base64url(newer))).statusCode).toBe(204);
    expect(t.inviteStore.rows.get(invite.id)?.keyBundle).toEqual(newer);
  });

  it('takes 48 bytes to 16 KiB of base64url: 413 above, 422 below or when not base64url', async () => {
    const { t, host, invite } = await setUp();
    expect(MIN_KEY_BUNDLE_BYTES).toBe(48);
    expect(MAX_KEY_BUNDLE_CHARS).toBe(16 * 1024);
    // The overhead alone, and the largest bundle (16 384 characters, 12 288 bytes).
    expect((await put(t, invite.id, host, base64url(randomBytes(48)))).statusCode).toBe(204);
    const largest = randomBytes(12 * 1024);
    expect(largest.toString('base64url')).toHaveLength(16 * 1024);
    expect((await put(t, invite.id, host, base64url(largest))).statusCode).toBe(204);
    const tooLong = { bundle: `${largest.toString('base64url')}A` };
    const res = await put(t, invite.id, host, tooLong);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'payload_too_large' });
    // A body far over the route's limit is refused before it is parsed.
    const huge = await put(t, invite.id, host, base64url(randomBytes(64 * 1024)));
    expect(huge.statusCode).toBe(413);
    for (const body of [
      base64url(randomBytes(47)),
      { bundle: 'not base64url!' },
      { bundle: `${randomBytes(60).toString('base64')}+/=` },
      { bundle: `${randomBytes(60).toString('base64url')}A` },
      { bundle: 42 },
      {},
      [],
    ]) {
      const refused = await put(t, invite.id, host, body);
      expect(refused.statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    // What was stored before is untouched.
    expect(t.inviteStore.rows.get(invite.id)?.keyBundle).toEqual(largest);
  });

  it('is for session hosts of the workspace: 403 host_required for others, 404 for outsiders', async () => {
    const { t, users, invite } = await setUp();
    const bundle = base64url(sealedBundle());
    for (const role of ['owner', 'admin', 'billing', 'guest'] as const) {
      const res = await put(t, invite.id, users[role], bundle);
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ code: 'host_required', detail: INVITE_DETAILS.hostOnly });
    }
    // A host of another workspace's session is no host here.
    const other = arrange(t.store);
    t.inviteStore.hosts.push({ workspaceId: other.workspaceId, userId: other.users.admin });
    expect((await put(t, invite.id, other.users.admin, bundle)).statusCode).toBe(404);
    // The sessions:host scope is needed, and a user.
    const scoped = await t.app.inject({
      method: 'PUT',
      url: `/v1/invites/${invite.id}/key-bundle`,
      headers: asUser(users.member),
      payload: bundle,
    });
    expect(scoped.statusCode).toBe(403);
    const anonymous = await t.app.inject({
      method: 'PUT',
      url: `/v1/invites/${invite.id}/key-bundle`,
      payload: bundle,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await put(t, 'inv_nope', users.member, bundle)).statusCode).toBe(404);
    expect(t.inviteStore.rows.get(invite.id)?.keyBundle).toBeNull();
  });

  it('is 410 for an invite expired, revoked, or accepted and fetched (or accepted 15 min ago)', async () => {
    const { t, workspaceId, users, host, invite } = await setUp();
    const bundle = base64url(sealedBundle());
    // Accepted: a bundle may still come, for 15 minutes, until fetched.
    const invitee = addUser(t.store);
    await accept(t, invite.token, invitee);
    t.clock.now = T0 + 5 * MINUTE_MS;
    expect((await put(t, invite.id, host, bundle)).statusCode).toBe(204);
    expect(t.inviteStore.rows.get(invite.id)?.keyBundleExpiresAt).toEqual(
      new Date(T0 + KEY_BUNDLE_AFTER_ACCEPT_MS),
    );
    expect((await take(t, invite.token, invitee)).statusCode).toBe(200);
    const fetched = await put(t, invite.id, host, bundle);
    expect(fetched.statusCode).toBe(410);
    expect(fetched.json()).toMatchObject({ code: 'gone' });

    t.clock.now = T0;
    const late = await createInvite(t, workspaceId, users.admin);
    await accept(t, late.token, addUser(t.store));
    t.clock.now = T0 + KEY_BUNDLE_AFTER_ACCEPT_MS;
    expect((await put(t, late.id, host, bundle)).statusCode).toBe(410);

    t.clock.now = T0;
    const revoked = await createInvite(t, workspaceId, users.admin);
    await t.app.inject({
      method: 'DELETE',
      url: `/v1/invites/${revoked.id}`,
      headers: asUser(users.admin),
    });
    const afterRevoke = await put(t, revoked.id, host, bundle);
    expect(afterRevoke.statusCode).toBe(410);
    expect(afterRevoke.json()).toMatchObject({ code: 'invite_revoked' });

    const expiring = await createInvite(t, workspaceId, users.admin);
    t.clock.now = T0 + 7 * DAY_MS;
    const afterExpiry = await put(t, expiring.id, host, bundle);
    expect(afterExpiry.statusCode).toBe(410);
    expect(afterExpiry.json()).toMatchObject({ code: 'invite_expired' });
  });
});

describe('fetching a key bundle', () => {
  it('returns the bytes once to the user who accepted; the next fetch is 410', async () => {
    const { t, host, invite } = await setUp();
    const sealed = sealedBundle(200);
    await put(t, invite.id, host, base64url(sealed));
    const invitee = addUser(t.store);
    // Before acceptance, nobody: the token alone is not enough.
    expect((await take(t, invite.token, invitee)).statusCode).toBe(403);
    await accept(t, invite.token, invitee);
    expect((await take(t, invite.token, addUser(t.store))).statusCode).toBe(403);
    t.clock.now = T0 + MINUTE_MS;
    const got = await take(t, invite.token, invitee);
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    const body = got.json<{ bundle: string }>();
    expect(validate('api/KeyBundle', body).ok).toBe(true);
    expect(Buffer.from(body.bundle, 'base64url')).toEqual(sealed);
    expect(t.inviteStore.rows.get(invite.id)).toMatchObject({
      keyBundle: null,
      keyBundleFetchedAt: new Date(T0 + MINUTE_MS),
    });
    const again = await take(t, invite.token, invitee);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: 'gone', detail: INVITE_DETAILS.bundleGone });
    // Never logged, in any form.
    for (const form of [sealed.toString('base64url'), sealed.toString('hex')]) {
      expect(t.captured.raw()).not.toContain(form);
    }
  });

  it('is 410 when no bundle was stored, 404 for an unknown token, 401 anonymous', async () => {
    const { t, invite } = await setUp();
    const invitee = addUser(t.store);
    await accept(t, invite.token, invitee);
    expect((await take(t, invite.token, invitee)).statusCode).toBe(410);
    expect((await take(t, randomBytes(20).toString('base64url'), invitee)).statusCode).toBe(404);
    const anonymous = await t.app.inject({ url: `/v1/invites/${invite.token}/key-bundle` });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('a key bundle goes', () => {
  it('on revocation', async () => {
    const { t, users, host, invite } = await setUp();
    await put(t, invite.id, host, base64url(sealedBundle()));
    await t.app.inject({
      method: 'DELETE',
      url: `/v1/invites/${invite.id}`,
      headers: asUser(users.admin),
    });
    expect(t.inviteStore.rows.get(invite.id)).toMatchObject({
      keyBundle: null,
      keyBundleExpiresAt: null,
    });
  });

  it('at the invite’s expiry, by the sweep within 5 minutes', async () => {
    const { t, host, invite } = await setUp();
    await put(t, invite.id, host, base64url(sealedBundle()));
    expect(await t.inviteStore.sweep(new Date(T0 + 7 * DAY_MS - 1))).toEqual({
      expired: 0,
      bundlesDropped: 0,
    });
    expect(await t.inviteStore.sweep(new Date(T0 + 7 * DAY_MS + 5 * MINUTE_MS))).toEqual({
      expired: 1,
      bundlesDropped: 0,
    });
    expect(t.inviteStore.rows.get(invite.id)).toMatchObject({
      keyBundle: null,
      keyBundleExpiresAt: null,
    });
  });

  it('15 minutes after acceptance if never fetched: the sweep drops it, and a fetch is 410', async () => {
    const { t, host, invite } = await setUp();
    await put(t, invite.id, host, base64url(sealedBundle()));
    const invitee = addUser(t.store);
    t.clock.now = T0 + MINUTE_MS;
    await accept(t, invite.token, invitee);
    const due = T0 + MINUTE_MS + KEY_BUNDLE_AFTER_ACCEPT_MS;
    expect(KEY_BUNDLE_AFTER_ACCEPT_MS).toBe(15 * MINUTE_MS);
    expect(await t.inviteStore.sweep(new Date(due - 1))).toEqual({ expired: 0, bundlesDropped: 0 });
    // Past its time, a fetch is 410 even before the sweep runs, and drops it.
    t.clock.now = due;
    expect((await take(t, invite.token, invitee)).statusCode).toBe(410);
    expect(t.inviteStore.rows.get(invite.id)).toMatchObject({
      keyBundle: null,
      keyBundleFetchedAt: null,
    });
  });

  it('15 minutes after acceptance, by the sweep', async () => {
    const { t, host, invite } = await setUp();
    await put(t, invite.id, host, base64url(sealedBundle()));
    await accept(t, invite.token, addUser(t.store));
    expect(await t.inviteStore.sweep(new Date(T0 + KEY_BUNDLE_AFTER_ACCEPT_MS))).toEqual({
      expired: 0,
      bundlesDropped: 1,
    });
    expect(t.inviteStore.rows.get(invite.id)?.keyBundle).toBeNull();
  });
});
