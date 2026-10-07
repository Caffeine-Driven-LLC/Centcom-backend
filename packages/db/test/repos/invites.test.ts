/**
 * The invite store on Postgres 16 (B029; DATABASE_URL, CI's integration job), in a throwaway
 * database with every migration: one pending invite per address per workspace (ignoring case),
 * any number of links, a token hash used once; lapsed invites expired on demand; rows locked by
 * token hash or id; acceptance and revocation; key bundles of 48 to 12 288 bytes, taken once and
 * only while live; session hosts of a workspace's unended sessions; addresses compared ignoring
 * case; pending invites by keyset; previews of live workspaces only; the sweep; and a purged
 * workspace's invites deleted by the purge hook, without which B027's purge is refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { Secret, type SigningKeys } from '@centcom/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createInviteStore,
  createWorkspaceStore,
  migrate,
  MIGRATIONS_DIR,
  type InviteDatabase,
  type InviteRecord,
  type InviteStore,
  type NewInvite,
} from '../../src/index.js';
import { ADMIN_URL, tempDatabase } from '../runner/helpers.js';

const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) }];
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

describe.runIf(ADMIN_URL !== undefined)('the invite store on Postgres 16', () => {
  let db: Kysely<InviteDatabase>;
  let drop: () => Promise<void>;
  let invites: InviteStore;
  beforeAll(async () => {
    let url: string;
    ({ url, drop } = await tempDatabase());
    db = createDb<InviteDatabase>({ url });
    await migrate(db, MIGRATIONS_DIR);
    invites = createInviteStore(db);
  }, 60_000);
  afterAll(async () => {
    await closeDb(db);
    await drop();
  });

  const addUser = async (displayName = 'Ada'): Promise<string> => {
    const id = newId('usr');
    await db
      .insertInto('users')
      .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: displayName })
      .execute();
    return id;
  };
  const workspace = async (owner: string): Promise<string> => {
    const id = newId('wsp');
    await createWorkspaceStore(db).transaction((tx) =>
      tx.insert({
        id,
        name: 'Acme',
        slug: `ws-${randomBytes(4).toString('hex')}`,
        ownerId: owner,
        membershipId: newId('mem'),
      }),
    );
    return id;
  };
  const token = (): { token: string; hash: Buffer } => {
    const value = randomBytes(20).toString('base64url');
    return { token: value, hash: createHash('sha256').update(value, 'utf8').digest() };
  };
  const draft = (
    workspaceId: string,
    createdBy: string,
    over: Partial<NewInvite> = {},
  ): NewInvite => ({
    id: newId('inv'),
    workspaceId,
    email: null,
    role: 'member',
    tokenHash: token().hash,
    createdBy,
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
    shareHistory: true,
    ...over,
  });
  /** Inserts; throws when the store wrote nothing. */
  const insert = async (input: NewInvite): Promise<InviteRecord> => {
    const row = await invites.transaction((tx) => tx.insert(input));
    if (row === null) throw new Error('insert: nothing written');
    return row;
  };
  const bundleRow = (id: string) =>
    db
      .selectFrom('invites')
      .select(['key_bundle', 'key_bundle_expires_at', 'token_hash'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('keeps one pending invite per address per workspace, any number of links, each hash once', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const t = token();
    const first = await insert(
      draft(wsp, owner, { email: 'grace@example.test', role: 'admin', tokenHash: t.hash }),
    );
    expect(first).toMatchObject({
      workspaceId: wsp,
      email: 'grace@example.test',
      role: 'admin',
      createdBy: owner,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
      expiredAt: null,
      shareHistory: true,
      hasKeyBundle: false,
      keyBundleFetchedAt: null,
    });
    expect(first.createdAt).toBeInstanceOf(Date);
    // Only the hash is stored.
    expect((await bundleRow(first.id)).token_hash).toEqual(t.hash);
    // The same address, whatever its case: nothing is written.
    const twin = draft(wsp, owner, { email: 'GRACE@example.test' });
    expect(await invites.transaction((tx) => tx.insert(twin))).toBeNull();
    expect(await invites.findById(twin.id)).toBeNull();
    // Links, and other workspaces, are not limited.
    await insert(draft(wsp, owner));
    await insert(draft(wsp, owner));
    await insert(draft(await workspace(owner), owner, { email: 'grace@example.test' }));
    // A token hash is used once.
    await expect(insert(draft(wsp, owner, { tokenHash: t.hash }))).rejects.toMatchObject({
      code: '23505',
      constraint: 'invites_token_hash_key',
    });
    // Revoked, the address may be invited again.
    await invites.transaction((tx) => tx.markRevoked(first.id, new Date()));
    await insert(draft(wsp, owner, { email: 'grace@example.test' }));
  });

  it('expires the lapsed pending invite of an address, and only that', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const lapsed = await insert(
      draft(wsp, owner, { email: 'ada@example.test', expiresAt: new Date(Date.now() - 1000) }),
    );
    const live = await insert(draft(wsp, owner, { email: 'bob@example.test' }));
    const now = new Date();
    await invites.transaction(async (tx) => {
      await tx.expireLapsed(wsp, 'ada@example.test', now);
      await tx.expireLapsed(wsp, 'bob@example.test', now);
    });
    expect((await invites.findById(lapsed.id))?.expiredAt).toEqual(now);
    expect((await invites.findById(live.id))?.expiredAt).toBeNull();
    await insert(draft(wsp, owner, { email: 'ada@example.test' }));
  });

  it('locks by hash or id, accepts, revokes, and hands a key bundle out once while it lasts', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const invitee = await addUser();
    const t = token();
    const inv = await insert(draft(wsp, owner, { tokenHash: t.hash }));
    const bundle = randomBytes(100);
    const expires = new Date(Date.now() + 7 * DAY_MS);
    await invites.transaction(async (tx) => {
      expect((await tx.lockByToken(t.hash))?.id).toBe(inv.id);
      expect(await tx.lockByToken(token().hash)).toBeNull();
      expect((await tx.lockById(inv.id))?.id).toBe(inv.id);
      expect(await tx.lockById(newId('inv'))).toBeNull();
      await tx.putKeyBundle(inv.id, bundle, expires);
    });
    expect((await invites.findById(inv.id))?.hasKeyBundle).toBe(true);
    expect(await bundleRow(inv.id)).toMatchObject({
      key_bundle: bundle,
      key_bundle_expires_at: expires,
    });
    // Accepted: the bundle now lasts 15 minutes.
    const acceptedAt = new Date();
    const until = new Date(acceptedAt.getTime() + 15 * MINUTE_MS);
    await invites.transaction((tx) => tx.markAccepted(inv.id, invitee, acceptedAt, until));
    expect(await invites.findById(inv.id)).toMatchObject({ acceptedAt, acceptedBy: invitee });
    expect((await bundleRow(inv.id)).key_bundle_expires_at).toEqual(until);
    const takenAt = new Date(acceptedAt.getTime() + MINUTE_MS);
    expect(await invites.transaction((tx) => tx.takeKeyBundle(inv.id, takenAt))).toEqual(bundle);
    expect(await invites.transaction((tx) => tx.takeKeyBundle(inv.id, takenAt))).toBeNull();
    expect(await invites.findById(inv.id)).toMatchObject({
      hasKeyBundle: false,
      keyBundleFetchedAt: takenAt,
    });
    expect(await bundleRow(inv.id)).toMatchObject({
      key_bundle: null,
      key_bundle_expires_at: null,
    });

    // Accepting an invite without a bundle sets no bundle expiry.
    const plain = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.markAccepted(plain.id, invitee, acceptedAt, until));
    expect((await bundleRow(plain.id)).key_bundle_expires_at).toBeNull();

    // A bundle past its time is not handed out, and goes.
    const stale = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.putKeyBundle(stale.id, bundle, new Date(Date.now() - 1)));
    expect(await invites.transaction((tx) => tx.takeKeyBundle(stale.id, new Date()))).toBeNull();
    expect(await invites.findById(stale.id)).toMatchObject({
      hasKeyBundle: false,
      keyBundleFetchedAt: null,
    });

    // Revoking drops the bundle.
    const revoked = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.putKeyBundle(revoked.id, bundle, expires));
    const at = new Date();
    await invites.transaction((tx) => tx.markRevoked(revoked.id, at));
    expect(await invites.findById(revoked.id)).toMatchObject({
      revokedAt: at,
      hasKeyBundle: false,
    });
  });

  it('stores bundles of 48 to 12 288 bytes, each with an expiry', async () => {
    const owner = await addUser();
    const inv = await insert(draft(await workspace(owner), owner));
    const expires = new Date(Date.now() + DAY_MS);
    for (const size of [48, 12 * 1024]) {
      await invites.transaction((tx) => tx.putKeyBundle(inv.id, randomBytes(size), expires));
    }
    for (const size of [47, 12 * 1024 + 1]) {
      await expect(
        invites.transaction((tx) => tx.putKeyBundle(inv.id, randomBytes(size), expires)),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      db
        .updateTable('invites')
        .set({ key_bundle_expires_at: null })
        .where('id', '=', inv.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('knows the hosts of a workspace’s unended sessions', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const elsewhere = await workspace(owner);
    const session = async (workspaceId: string, state: 'pending' | 'live' | 'paused' | 'ended') => {
      const id = newId('ses');
      await db
        .insertInto('sessions')
        .values({
          id,
          workspace_id: workspaceId,
          name: 'S',
          region: 'eu',
          created_by: owner,
          state,
        })
        .execute();
      return id;
    };
    const join = async (
      sessionId: string,
      role: 'host' | 'editor' | 'viewer',
      slot: number,
      leftAt: Date | null = null,
    ): Promise<string> => {
      const userId = await addUser();
      const deviceId = newId('dev');
      await db
        .insertInto('devices')
        .values({
          id: deviceId,
          user_id: userId,
          name: 'Laptop',
          platform: 'linux',
          x25519_pub: randomBytes(32).toString('base64url'),
          ed25519_pub: randomBytes(32).toString('base64url'),
          fingerprint: 'ABCD-EFGH-IJKL',
        })
        .execute();
      await db
        .insertInto('session_members')
        .values({
          id: newId('mem'),
          session_id: sessionId,
          user_id: userId,
          device_id: deviceId,
          role,
          slot,
          left_at: leftAt,
        })
        .execute();
      return userId;
    };
    const live = await session(wsp, 'live');
    const host = await join(live, 'host', 0);
    const editor = await join(live, 'editor', 1);
    const left = await join(live, 'host', 2, new Date());
    const pausedHost = await join(await session(wsp, 'paused'), 'host', 0);
    const pendingHost = await join(await session(wsp, 'pending'), 'host', 0);
    const endedHost = await join(await session(wsp, 'ended'), 'host', 0);
    const otherHost = await join(await session(elsewhere, 'live'), 'host', 0);
    await invites.transaction(async (tx) => {
      for (const userId of [host, pausedHost, pendingHost]) {
        expect(await tx.hostsSessionIn(wsp, userId)).toBe(true);
      }
      for (const userId of [editor, left, endedHost, otherHost, owner]) {
        expect(await tx.hostsSessionIn(wsp, userId)).toBe(false);
      }
    });
  });

  it('reads a user’s address, and members’ addresses ignoring case', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    const address = `${owner.toLowerCase()}@example.test`;
    await invites.transaction(async (tx) => {
      expect(await tx.emailOf(owner)).toBe(address);
      expect(await tx.emailOf(newId('usr'))).toBeNull();
      expect(await tx.isMemberEmail(wsp, address.toUpperCase())).toBe(true);
      expect(await tx.isMemberEmail(wsp, 'nobody@example.test')).toBe(false);
      expect(await tx.isMemberEmail(await workspace(await addUser()), address)).toBe(false);
      // The member operations share the transaction.
      expect(await tx.members.lockWorkspace(wsp)).toBe(true);
    });
  });

  it('lists pending invites oldest first by keyset, and previews those of live workspaces', async () => {
    const owner = await addUser('Grace');
    const wsp = await workspace(owner);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await insert(draft(wsp, owner))).id);
    const accepted = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.markAccepted(accepted.id, owner, new Date(), new Date()));
    const revoked = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.markRevoked(revoked.id, new Date()));
    await insert(draft(wsp, owner, { expiresAt: new Date(Date.now() - 1000) }));
    const params = { sort: 'created', filterHash: 'f', keys: KEYS, now: Date.now() };
    const first = await invites.listPending(wsp, new Date(), { ...params, limit: 2 });
    const second = await invites.listPending(wsp, new Date(), {
      ...params,
      limit: 2,
      cursor: first.next_cursor ?? '',
    });
    expect([...first.data, ...second.data].map((i) => i.id)).toEqual(ids);
    expect(second.next_cursor).toBeNull();

    const t = token();
    const inv = await insert(draft(wsp, owner, { tokenHash: t.hash, role: 'guest' }));
    expect(await invites.preview(t.hash)).toMatchObject({
      workspaceName: 'Acme',
      inviterName: 'Grace',
      invite: { id: inv.id, role: 'guest' },
    });
    expect(await invites.preview(token().hash)).toBeNull();
    await createWorkspaceStore(db).transaction((tx) => tx.softDelete(wsp));
    expect(await invites.preview(t.hash)).toBeNull();
  });

  it('sweeps: lapsed invites expire with their bundles, bundles past their time go', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    // What earlier tests left due goes first.
    const now = new Date();
    await invites.sweep(now);
    const bundle = randomBytes(64);
    const past = new Date(now.getTime() - MINUTE_MS);
    const lapsed = await insert(draft(wsp, owner, { expiresAt: past }));
    await invites.transaction((tx) => tx.putKeyBundle(lapsed.id, bundle, lapsed.expiresAt));
    const unfetched = await insert(draft(wsp, owner));
    await invites.transaction(async (tx) => {
      await tx.putKeyBundle(unfetched.id, bundle, unfetched.expiresAt);
      await tx.markAccepted(unfetched.id, owner, past, past);
    });
    const waiting = await insert(draft(wsp, owner));
    await invites.transaction((tx) => tx.putKeyBundle(waiting.id, bundle, waiting.expiresAt));
    expect(await invites.sweep(now)).toEqual({ expired: 1, bundlesDropped: 1 });
    expect(await invites.findById(lapsed.id)).toMatchObject({
      expiredAt: now,
      hasKeyBundle: false,
    });
    expect(await invites.findById(unfetched.id)).toMatchObject({
      expiredAt: null,
      hasKeyBundle: false,
    });
    expect((await invites.findById(waiting.id))?.hasKeyBundle).toBe(true);
    // Idempotent.
    expect(await invites.sweep(now)).toEqual({ expired: 0, bundlesDropped: 0 });
  });

  it('deletes a purged workspace’s invites (never a live one’s), which B027’s purge needs', async () => {
    const owner = await addUser();
    const wsp = await workspace(owner);
    await insert(draft(wsp, owner));
    await insert(draft(wsp, owner, { email: 'grace@example.test' }));
    const workspaces = createWorkspaceStore(db);
    expect(await invites.deleteForWorkspace(wsp)).toBe(0);
    await workspaces.transaction((tx) => tx.softDelete(wsp));
    // The foreign key restricts: the purge is refused while invites remain.
    await expect(workspaces.purge(wsp)).rejects.toMatchObject({ code: '23503' });
    expect(await invites.deleteForWorkspace(wsp)).toBe(2);
    expect(await workspaces.purge(wsp)).toEqual({ purged: true });
    expect(await invites.deleteForWorkspace(wsp)).toBe(0);
  });
});
