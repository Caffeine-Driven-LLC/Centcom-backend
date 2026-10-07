/**
 * Invites over Postgres 16 (B029; DATABASE_URL, CI's integration job): the routes over the SQL
 * stores and B021's Postgres membership reader, through create, preview, a key bundle, accept and
 * revoke; then a dump of the invites and audit tables and the logs holds no token in any form
 * (acceptance 2, card test invites.token-secrecy.test.ts against the database); and 10 accepts
 * racing for the last seat against the database's locks make exactly one membership (acceptance
 * 5, card test invites.seat-race.test.ts), with a seat gate that counts the members in the
 * accepting transaction, as B030's does.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { AppError, createEmailService, createMemoryRedis } from '@centcom/core';
import {
  createInviteStore,
  createMemberStore,
  createMembershipRepo,
  createWorkspaceStore,
  type CoreDatabase,
  type InviteDatabase,
} from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { InviteService, inviteRoutes, type SeatGate } from '../../../src/modules/invites/index.js';
import { MembershipService, memberRoutes } from '../../../src/modules/members/index.js';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { buildWorkspacesApp, KEYS } from '../workspaces/helpers.js';
import { asHost, asInvitee, asUser, sealedBundle, URLS } from './helpers.js';

/** Every form a token could be written in: as given, and its bytes in hex and base64. */
const forms = (token: string): string[] => {
  const bytes = Buffer.from(token, 'base64url');
  return [token, bytes.toString('hex'), bytes.toString('base64')];
};

/** Rows as text, byte columns in hex and base64url. */
const dump = (rows: unknown[]): string =>
  JSON.stringify(rows, (_key, value: unknown) => {
    if (typeof value === 'object' && value !== null && 'type' in value && 'data' in value) {
      const data = (value as { data: unknown }).data;
      if (Array.isArray(data)) {
        const bytes = Buffer.from(data as number[]);
        return [bytes.toString('hex'), bytes.toString('base64url')];
      }
    }
    return value;
  });

describe.runIf(ADMIN_URL !== undefined)('invites on Postgres 16', () => {
  it('run over the SQL stores, keep no token, and give the last seat to one of 10', async () => {
    const t = await migratedDatabase(20);
    try {
      const db = t.db as unknown as Kysely<InviteDatabase>;
      const workspaces = createWorkspaceStore(t.db);
      let seats = Number.POSITIVE_INFINITY;
      const gate: SeatGate = {
        async assertCanAdd(trx, workspaceId) {
          const counted = await sql<{ n: string }>`
            select count(*) as n from memberships where workspace_id = ${workspaceId}
          `.execute(trx as unknown as Transaction<CoreDatabase>);
          if (Number(counted.rows[0]?.n) >= seats) {
            throw new AppError('seat_limit_reached', { detail: 'No seat is free.' });
          }
        },
      };
      const mails: string[] = [];
      const backend = createMemoryRedis();
      const email = createEmailService({
        queue: {
          add: (_name, data) => {
            mails.push(`${data.email.text}\n${data.email.html}`);
            return Promise.resolve({ id: 'job' });
          },
        },
        rateLimit: backend.rateLimit,
        kv: backend.kv,
        from: 'Centcom <no-reply@centcom.test>',
      });
      const { app, captured } = await buildWorkspacesApp(workspaces, createMembershipRepo(t.db), {
        auditPool: t.db,
        beforeReady: async (server, ctx) => {
          const members = new MembershipService({
            store: createMemberStore(t.db),
            events: ctx.events,
            sleep: () => Promise.resolve(),
          });
          const service = new InviteService({
            store: createInviteStore(db),
            members,
            urls: URLS,
            email,
            logger: ctx.captured.logger,
          });
          server.decorate('seatGate', gate);
          await server.register(memberRoutes, { members, workspaces, cursorKeys: KEYS });
          await server.register(inviteRoutes, { service, workspaces, cursorKeys: KEYS });
        },
      });
      const addUser = async (address?: string): Promise<string> => {
        const id = newId('usr');
        await t.db
          .insertInto('users')
          .values({
            id,
            email: address ?? `${id.toLowerCase()}@example.test`,
            display_name: 'Ada',
          })
          .execute();
        return id;
      };
      const join = async (workspaceId: string, userId: string, role: 'admin' | 'member') =>
        t.db
          .insertInto('memberships')
          .values({ id: newId('mem'), workspace_id: workspaceId, user_id: userId, role })
          .execute();
      const create = async (userId: string, payload: object = {}) =>
        app.inject({
          method: 'POST',
          url: `/v1/workspaces/${workspaceId}/invites`,
          headers: { ...asUser(userId), 'idempotency-key': randomUUID() },
          payload,
        });
      const accept = (token: string, userId: string) =>
        app.inject({
          method: 'POST',
          url: `/v1/invites/${token}/accept`,
          headers: asInvitee(userId),
        });

      const owner = await addUser();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: asUser(owner),
        payload: { name: 'Acme' },
      });
      const workspaceId = String(created.json<{ id: string }>().id);
      const admin = await addUser();
      await join(workspaceId, admin, 'admin');

      // A link invite, and an e-mail one (mailed, one pending per address).
      const linkRes = await create(owner);
      expect(linkRes.statusCode).toBe(201);
      const link = linkRes.json<{ id: string; token: string }>();
      const mailedRes = await create(admin, { email: 'grace@example.test', role: 'member' });
      expect(mailedRes.statusCode).toBe(201);
      const mailed = mailedRes.json<{ id: string; token: string }>();
      expect(mails.join('\n')).toContain(mailed.token);
      expect((await create(admin, { email: 'grace@example.test' })).statusCode).toBe(409);
      const preview = await app.inject({ url: `/v1/invites/${link.token}` });
      expect(preview.json()).toMatchObject({ workspace_name: 'Acme', inviter_name: 'Ada' });

      // A host of a live session of the workspace stores a key bundle.
      const host = await addUser();
      await join(workspaceId, host, 'member');
      const deviceId = newId('dev');
      await t.db
        .insertInto('devices')
        .values({
          id: deviceId,
          user_id: host,
          name: 'Laptop',
          platform: 'linux',
          x25519_pub: randomBytes(32).toString('base64url'),
          ed25519_pub: randomBytes(32).toString('base64url'),
          fingerprint: 'ABCD-EFGH-IJKL',
        })
        .execute();
      const sessionId = newId('ses');
      await t.db
        .insertInto('sessions')
        .values({
          id: sessionId,
          workspace_id: workspaceId,
          name: 'S',
          region: 'eu',
          created_by: host,
          state: 'live',
        })
        .execute();
      await t.db
        .insertInto('session_members')
        .values({
          id: newId('mem'),
          session_id: sessionId,
          user_id: host,
          device_id: deviceId,
          role: 'host',
          slot: 0,
        })
        .execute();
      const bundle = sealedBundle(128);
      const put = await app.inject({
        method: 'PUT',
        url: `/v1/invites/${link.id}/key-bundle`,
        headers: asHost(host),
        payload: { bundle: bundle.toString('base64url') },
      });
      expect(put.statusCode).toBe(204);
      const byAdmin = await app.inject({
        method: 'PUT',
        url: `/v1/invites/${link.id}/key-bundle`,
        headers: asHost(admin),
        payload: { bundle: bundle.toString('base64url') },
      });
      expect(byAdmin.statusCode).toBe(403);

      // Accepted once, the bundle fetched once.
      const invitee = await addUser();
      const accepted = await accept(link.token, invitee);
      expect(accepted.statusCode).toBe(201);
      const again = await accept(link.token, invitee);
      expect(again.json<{ member: { id: string } }>().member.id).toBe(
        accepted.json<{ member: { id: string } }>().member.id,
      );
      const take = () =>
        app.inject({ url: `/v1/invites/${link.token}/key-bundle`, headers: asInvitee(invitee) });
      const got = await take();
      expect(got.statusCode).toBe(200);
      expect(Buffer.from(got.json<{ bundle: string }>().bundle, 'base64url')).toEqual(bundle);
      expect((await take()).statusCode).toBe(410);

      // The address's owner accepts the e-mail invite; another address may not.
      expect((await accept(mailed.token, await addUser())).statusCode).toBe(403);
      const grace = await addUser('grace@example.test');
      expect((await accept(mailed.token, grace)).statusCode).toBe(201);

      // Revoked: gone.
      const doomedRes = await create(owner);
      const doomed = doomedRes.json<{ id: string; token: string }>();
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/invites/${doomed.id}`,
        headers: asUser(admin),
      });
      expect(revoked.statusCode).toBe(204);
      expect((await app.inject({ url: `/v1/invites/${doomed.token}` })).statusCode).toBe(410);
      const listed = await app.inject({
        url: `/v1/workspaces/${workspaceId}/invites`,
        headers: asUser(admin),
      });
      expect(listed.json<{ data: unknown[] }>().data).toEqual([]);

      // No token in the tables or the logs; the stored hash is the token's sha256.
      const invites = await sql`select * from invites`.execute(t.db);
      const audit = await sql`select * from audit_events`.execute(t.db);
      const places = {
        invites: dump(invites.rows),
        audit: dump(audit.rows),
        logs: captured.raw(),
      };
      for (const token of [link.token, mailed.token, doomed.token]) {
        for (const [place, text] of Object.entries(places)) {
          for (const form of forms(token)) expect(text, place).not.toContain(form);
        }
        const row = await db
          .selectFrom('invites')
          .select('token_hash')
          .where('token_hash', '=', createHash('sha256').update(token, 'utf8').digest())
          .executeTakeFirst();
        expect(row).toBeDefined();
      }
      const actions = audit.rows.map((r) => (r as { action: string }).action);
      expect(actions).toEqual(
        expect.arrayContaining(['invite.create', 'invite.accept', 'invite.revoke', 'member.add']),
      );

      // Ten accepts race for the last seat; the database's locks let one through.
      const before = await sql<{ n: string }>`
        select count(*) as n from memberships where workspace_id = ${workspaceId}
      `.execute(t.db);
      const members = Number(before.rows[0]?.n);
      const racers: { token: string; userId: string }[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await create(owner);
        expect(res.statusCode).toBe(201);
        racers.push({ token: res.json<{ token: string }>().token, userId: await addUser() });
      }
      seats = members + 1;
      const results = await Promise.all(racers.map((r) => accept(r.token, r.userId)));
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, ...Array<number>(9).fill(403)]);
      for (const refused of results.filter((r) => r.statusCode === 403)) {
        expect(refused.json()).toMatchObject({ code: 'seat_limit_reached' });
      }
      const after = await sql<{ n: string }>`
        select count(*) as n from memberships where workspace_id = ${workspaceId}
      `.execute(t.db);
      expect(Number(after.rows[0]?.n)).toBe(members + 1);
      const winners = await sql<{ n: string }>`
        select count(*) as n from invites
        where workspace_id = ${workspaceId} and accepted_at is not null
          and accepted_by = any(${racers.map((r) => r.userId)})
      `.execute(t.db);
      expect(Number(winners.rows[0]?.n)).toBe(1);
      await app.close();
    } finally {
      await t.drop();
    }
  }, 120_000);
});
