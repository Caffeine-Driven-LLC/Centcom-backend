/**
 * Session invites over Postgres 16 (B105; DATABASE_URL, CI's integration job), with migration
 * 20260102005200_session_invites.sql: one person into ONE session without a seat.
 *
 * - accepting uses no seat and makes no workspace membership, yet the route store's standing and
 *   the members list show the person as a member at the invited role (capped by it);
 * - revoking withdraws the grant; a revoked, expired or used invite answers as workspace invites do;
 * - an invite bound to an address is for that user only; one pending invite per address (409);
 * - the host's sealed key bundle is fetched once, by the user who accepted;
 * - a workspace without `relay_access` cannot create one; an ended session cannot;
 * - only the token's hash is stored.
 */
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  createSessionInviteStore,
  type CoreDatabase,
  type SessionInviteDatabase,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionInviteService } from '../../../src/modules/invites/index.js';
import {
  createSessionRouteStore,
  type SessionRoutesDb,
} from '../../../src/routes/sessions/index.js';
import { pgUser } from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase, T0 } from '../../sessions/lifecycle/helpers.js';
import type { TestDatabase } from '../users/helpers.js';

const URLS = {
  inviteUrl: (t: string) => `https://centcom.test/i/${t}`,
  joinUrl: (t: string) => `centcom://i/${t}`,
};

describe.runIf(ADMIN_URL !== undefined)('session invites on Postgres 16', () => {
  let test: TestDatabase;
  let db: Kysely<CoreDatabase>;
  beforeAll(async () => {
    test = await migratedDatabase(20);
    db = test.db;
  });
  afterAll(async () => {
    await test?.drop();
  });

  async function world(plan: 'free' | 'pro' | 'team' = 'pro', auditThrows = false) {
    const env = lifecycleOn(db, plan);
    const w = await env.seed();
    const s = await env.service.create({
      workspaceId: w.workspace,
      creatorUserId: w.owner.user,
      creatorDeviceId: w.owner.device,
      name: 'Release train',
      region: 'eu',
    });
    const sent: { to: string; params: Record<string, unknown> }[] = [];
    const audited: { action: string; actor: { id: string }; meta?: Record<string, unknown> }[] = [];
    let now = T0;
    const service = new SessionInviteService({
      store: createSessionInviteStore(db as unknown as Kysely<SessionInviteDatabase>),
      urls: URLS,
      email: {
        send: (_t: unknown, to: string, params: unknown) => {
          sent.push({ to, params: params as Record<string, unknown> });
          return Promise.resolve({ queued: true } as never);
        },
      } as never,
      entitlements: { check: (ws, key) => env.entitlements.port.check(ws, key) },
      audit: {
        emitDetached: (e) => {
          if (auditThrows) throw new Error('audit store is down');
          audited.push(e as never);
        },
      },
      clock: () => now,
    });
    const session = { id: s.id, workspaceId: w.workspace, name: 'Release train', state: 'live' };
    return { env, w, s, service, session, sent, audited, advance: (ms: number) => (now += ms) };
  }

  const memberships = async (user: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from memberships where user_id = ${user}`.execute(db)
      ).rows[0]?.n,
    );

  it('an invitee outside the workspace gets a grant: no seat, no membership, a member in the session', async () => {
    const { w, s, service, session } = await world('pro');
    const outsider = await pgUser(db);
    const seatsBefore = await sql<{
      n: string;
    }>`select count(*) as n from memberships where workspace_id = ${w.workspace}`.execute(db);
    const created = await service.create(session, w.owner.user, 'Owner', {
      role: 'editor',
      expiresInS: 3600,
      shareHistory: true,
    });
    const preview = await service.preview(created.token);
    expect(preview).toMatchObject({
      sessionName: 'Release train',
      inviterName: 'User',
      role: 'editor',
    });
    const accepted = await service.accept(created.token, outsider);
    expect(accepted).toEqual({ sessionId: s.id, role: 'editor', workspaceId: w.workspace });
    expect(await memberships(outsider)).toBe(0);
    const seatsAfter = await sql<{
      n: string;
    }>`select count(*) as n from memberships where workspace_id = ${w.workspace}`.execute(db);
    expect(seatsAfter.rows[0]?.n).toBe(seatsBefore.rows[0]?.n);
    // The same user again: the same grant.
    expect(await service.accept(created.token, outsider)).toEqual(accepted);
    const store = createSessionRouteStore(db as unknown as SessionRoutesDb);
    const standing = await store.standing(s.id, outsider);
    expect(standing).toMatchObject({ workspaceRole: null, grantRole: 'editor', member: null });
    // Joins as the grant says (the join route's insert), then the members list shows them.
    const device = newId('dev');
    await db
      .insertInto('devices')
      .values({
        id: device,
        user_id: outsider,
        name: 'L',
        platform: 'linux',
        x25519_pub: 'C'.repeat(43),
        ed25519_pub: 'D'.repeat(43),
        fingerprint: 'AAAA-BBBB-CCCC',
      })
      .execute();
    const member = await store.addMember({
      sessionId: s.id,
      memberId: newId('mem'),
      userId: outsider,
      deviceId: device,
      role: 'viewer',
      slot: 5,
      at: new Date(T0),
    });
    expect(member.kind).toBe('added');
    const listed = await store.members(s.id, 0, 50);
    expect(listed.map((m) => m.userId)).toContain(outsider);
    expect(listed.find((m) => m.userId === outsider)?.grantRole).toBe('editor');
  });

  it('writes audit events for create, accept and revoke, and mails the session-invite template (B108)', async () => {
    const { w, service, session, sent, audited } = await world('pro');
    const outsider = await pgUser(db);
    const mailed = await service.create(session, w.owner.user, 'Owner', {
      role: 'editor',
      email: 'friend@example.test',
      expiresInS: 3600,
      shareHistory: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({
      inviterName: 'Owner',
      sessionName: 'Release train',
      role: 'editor',
    });
    await service.accept(mailed.token, outsider).catch(() => undefined);
    const link = await service.create(session, w.owner.user, 'Owner', {
      role: 'viewer',
      expiresInS: 3600,
      shareHistory: true,
    });
    await service.accept(link.token, outsider);
    await service.revoke(link.invite, w.owner.user);
    expect(audited.map((e) => e.action)).toEqual([
      'invite.create',
      'invite.create',
      'invite.accept',
      'invite.revoke',
    ]);
    expect(audited[0]).toMatchObject({
      actor: { id: w.owner.user },
      meta: { role: 'editor', kind: 'session' },
    });
    expect(audited[2]).toMatchObject({
      actor: { id: outsider },
      meta: { user_id: outsider, role: 'viewer' },
    });
    expect(JSON.stringify(audited)).not.toContain(link.token);
  });

  it('an audit write that throws does not fail create, accept or revoke (B108)', async () => {
    const { w, service, session } = await world('pro', true);
    const outsider = await pgUser(db);
    const created = await service.create(session, w.owner.user, 'Owner', {
      role: 'viewer',
      expiresInS: 3600,
      shareHistory: true,
    });
    expect(await service.accept(created.token, outsider)).toMatchObject({ role: 'viewer' });
    await expect(service.revoke(created.invite, w.owner.user)).resolves.toBeUndefined();
  });

  it('revoking withdraws the right; a revoked invite is 410; an unknown token is not a session invite', async () => {
    const { w, s, service, session } = await world('pro');
    const outsider = await pgUser(db);
    const a = await service.create(session, w.owner.user, 'Owner', {
      role: 'viewer',
      expiresInS: 3600,
      shareHistory: true,
    });
    await service.accept(a.token, outsider);
    const store = createSessionRouteStore(db as unknown as SessionRoutesDb);
    expect((await store.standing(s.id, outsider))?.grantRole).toBe('viewer');
    await service.revoke(a.invite);
    expect((await store.standing(s.id, outsider))?.grantRole).toBeNull();
    await expect(service.accept(a.token, await pgUser(db))).rejects.toMatchObject({
      code: 'invite_revoked',
    });
    await expect(service.preview(a.token)).rejects.toMatchObject({ code: 'invite_revoked' });
    expect(await service.preview('A'.repeat(27))).toBeNull();
    expect(await service.accept('not-a-token', outsider)).toBeNull();
  });

  it('an expired invite is 410, and a bound address is for that user only', async () => {
    const { w, service, session, advance } = await world('pro');
    const bound = await pgUser(db);
    const other = await pgUser(db);
    const email =
      (
        await sql<{
          email: string;
        }>`select email::text as email from users where id = ${bound}`.execute(db)
      ).rows[0]?.email ?? '';
    const forBound = await service.create(session, w.owner.user, 'Owner', {
      email,
      role: 'editor',
      expiresInS: 120,
      shareHistory: true,
    });
    await expect(service.accept(forBound.token, other)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service.create(session, w.owner.user, 'Owner', {
        email,
        role: 'editor',
        expiresInS: 120,
        shareHistory: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    advance(121_000);
    await expect(service.accept(forBound.token, bound)).rejects.toMatchObject({
      code: 'invite_expired',
    });
  });

  it('the sealed key bundle is fetched once, by the user who accepted', async () => {
    const { w, service, session } = await world('pro');
    const outsider = await pgUser(db);
    const created = await service.create(session, w.owner.user, 'Owner', {
      role: 'editor',
      expiresInS: 3600,
      shareHistory: true,
    });
    await service.putKeyBundle(created.invite, Buffer.alloc(80, 7));
    await service.accept(created.token, outsider);
    await expect(service.takeKeyBundle(created.token, await pgUser(db))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await service.takeKeyBundle(created.token, outsider))?.length).toBe(80);
    await expect(service.takeKeyBundle(created.token, outsider)).rejects.toMatchObject({
      code: 'gone',
    });
  });

  it('a plan without the relay, or an ended session, cannot be invited to; only the token hash is stored', async () => {
    const free = await world('pro');
    free.env.entitlements.state.limits['relay_access'] = false;
    await expect(
      free.service.create(free.session, free.w.owner.user, 'Owner', {
        role: 'editor',
        expiresInS: 3600,
        shareHistory: true,
      }),
    ).rejects.toMatchObject({ code: 'entitlement_required' });
    const { w, service, session } = await world('pro');
    await expect(
      service.create({ ...session, state: 'ended' }, w.owner.user, 'Owner', {
        role: 'editor',
        expiresInS: 3600,
        shareHistory: true,
      }),
    ).rejects.toMatchObject({ code: 'session_ended' });
    const created = await service.create(session, w.owner.user, 'Owner', {
      role: 'editor',
      expiresInS: 3600,
      shareHistory: true,
    });
    const rows = await sql<{
      token_hash: Buffer;
    }>`select token_hash from session_invites where id = ${created.invite.id}`.execute(db);
    expect(
      rows.rows[0]?.token_hash.equals(createHash('sha256').update(created.token, 'utf8').digest()),
    ).toBe(true);
    const dump = JSON.stringify((await sql`select * from session_invites`.execute(db)).rows);
    expect(dump).not.toContain(created.token);
  });
});
