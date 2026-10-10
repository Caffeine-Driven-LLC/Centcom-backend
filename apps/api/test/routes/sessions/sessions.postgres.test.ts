/**
 * The session routes on Postgres 16 (B054; DATABASE_URL, CI's integration job): the Postgres
 * route store, B031's slot store and B053's service behind the same plugin stack.
 *
 * - join-token: the member row gets B031's slot (the same in `session_member_slots`); five
 *   concurrent first joins of one user leave one live row;
 * - members: join order and exactly the stored keys;
 * - claim-host: roles swap, `host_member_id` moves, the outbox row is delivered (or stays queued
 *   with the notifier down), the `control.transfer_host` audit row commits with it; refused while
 *   the host is connected, with nothing changed;
 * - PATCH: two PATCHes with the same ETag, one 200 and one 412 (the row lock); 12 concurrent
 *   PATCHes on a pool of 10 all answer (one connection each);
 * - claim-host demotes a host a relay-side transfer left out of `host_member_id`;
 * - a kicked member (B051's `left_at`) gets no ticket.
 */
import { validate } from '@centcom/contracts';
import {
  createMembershipRepo,
  createSessionSlotStore,
  type SessionSlotDatabase,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSessionRouteStore,
  type SessionRoutesDb,
} from '../../../src/routes/sessions/index.js';
import type { TestDatabase } from '../../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase } from '../../sessions/lifecycle/helpers.js';
import { sessionsApp } from './helpers.js';

describe.runIf(ADMIN_URL !== undefined)('the session routes on Postgres 16', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await migratedDatabase(10);
  });
  afterAll(async () => {
    await test?.drop();
  });
  /** The database with the lifecycle's and the routes' tables. */
  const db = (): SessionRoutesDb => test.db as unknown as SessionRoutesDb;

  async function setup() {
    const life = lifecycleOn(test.db, 'team');
    const w = await life.seed();
    const env = await sessionsApp({
      reader: createMembershipRepo(test.db),
      deps: {
        service: life.service,
        store: createSessionRouteStore(db()),
        slots: createSessionSlotStore(test.db as unknown as Kysely<SessionSlotDatabase>),
        entitlements: {
          check: (ws, key, current) =>
            life.entitlements.port.check(ws, key as 'relay_access', current),
        },
      },
    });
    const { id: sid } = await env.create(w.owner, w.workspace);
    const join = async (who: { user: string; device: string }) =>
      env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sid}/join-token`,
        headers: await env.as(who),
        payload: {},
      });
    const members = () =>
      db()
        .selectFrom('session_members')
        .selectAll()
        .where('session_id', '=', sid)
        .orderBy('joined_at')
        .execute();
    return { ...env, life, w, sid, join, members };
  }

  it('joins with B031’s slot, once per user under concurrency', async () => {
    const env = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => env.join(env.w.member)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const rows = (await env.members()).filter((r) => r.user_id === env.w.member.user);
    expect(rows.filter((r) => r.left_at === null)).toHaveLength(1);
    const row = rows.find((r) => r.left_at === null);
    expect(new Set(results.map((r) => r.json<{ member: string }>().member))).toEqual(
      new Set([row?.id]),
    );
    const slot = await db()
      .selectFrom('session_member_slots')
      .select('slot')
      .where('session_id', '=', env.sid)
      .where('member_id', '=', String(row?.id))
      .executeTakeFirst();
    expect(slot?.slot).toBe(row?.slot);
    // The four losing joins gave their slots back: only the host's and the winner's remain.
    const slots = await db()
      .selectFrom('session_member_slots')
      .select('member_id')
      .where('session_id', '=', env.sid)
      .execute();
    const host = (await env.members()).find((r) => r.user_id === env.w.owner.user);
    expect(slots.map((r) => r.member_id).sort()).toEqual(
      [String(host?.id), String(row?.id)].sort(),
    );
  });

  it('lists members in join order with exactly the stored keys', async () => {
    const env = await setup();
    await env.join(env.w.member);
    await env.join(env.w.admin);
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}/members`,
      headers: await env.as(env.w.owner),
    });
    expect(res.statusCode).toBe(200);
    expect(validate('api/SessionMemberPage', res.json()).ok).toBe(true);
    const body = res.json<{
      data: { user: string; join_order: number; device_keys: Record<string, unknown> }[];
    }>();
    expect(body.data.map((m) => m.user)).toEqual([
      env.w.owner.user,
      env.w.member.user,
      env.w.admin.user,
    ]);
    expect(body.data.map((m) => m.join_order)).toEqual([1, 2, 3]);
    expect(body.data[1]?.device_keys).toEqual({
      device: env.w.member.device,
      x25519: 'A'.repeat(43),
      ed25519: 'B'.repeat(43),
      fingerprint: 'AAAA-BBBB-CCCC',
      revoked: false,
    });
  });

  it('claims the host in one transaction with its audit row and outbox row', async () => {
    const env = await setup();
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/claim-host`,
      headers: await env.as(env.w.admin),
    });
    expect(res.statusCode).toBe(200);
    const rows = await env.members();
    const admin = rows.find((r) => r.user_id === env.w.admin.user);
    const owner = rows.find((r) => r.user_id === env.w.owner.user);
    expect(admin?.role).toBe('host');
    expect(owner?.role).toBe('editor');
    const session = await db()
      .selectFrom('sessions')
      .select('host_member_id')
      .where('id', '=', env.sid)
      .executeTakeFirst();
    expect(session?.host_member_id).toBe(admin?.id);
    // Delivered rows are deleted.
    const outbox = await sql<{ attempts: number }>`
      select attempts from session_host_outbox where session_id = ${env.sid}
    `.execute(test.db);
    expect(outbox.rows).toHaveLength(0);
    expect(env.hostChanges).toEqual([{ sid: env.sid, host: admin?.id, code: 'failover' }]);
    const audit = await sql<{ n: string }>`
      select count(*) as n from audit_events
      where action = 'control.transfer_host' and target_id = ${String(admin?.id)}
    `.execute(test.db);
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('keeps the change queued with the notifier down, and refuses while the host is connected', async () => {
    const env = await setup();
    await db()
      .updateTable('sessions')
      .set({ host_connected: true })
      .where('id', '=', env.sid)
      .execute();
    const refused = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/claim-host`,
      headers: await env.as(env.w.admin),
    });
    expect(refused.statusCode).toBe(409);
    expect((await env.members()).find((r) => r.role === 'host')?.user_id).toBe(env.w.owner.user);
    await db()
      .updateTable('sessions')
      .set({ host_connected: false })
      .where('id', '=', env.sid)
      .execute();
    env.flags.failNotifier = true;
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/claim-host`,
      headers: await env.as(env.w.admin),
    });
    expect(res.statusCode).toBe(200);
    const outbox = await sql<{ attempts: number }>`
      select attempts from session_host_outbox where session_id = ${env.sid}
    `.execute(test.db);
    expect(outbox.rows).toEqual([{ attempts: 1 }]);
  });

  it('lets one of two PATCHes with the same ETag through', async () => {
    const env = await setup();
    const got = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${env.sid}`,
      headers: await env.as(env.w.owner),
    });
    const etag = String(got.headers['etag']);
    const headers = { ...(await env.as(env.w.owner)), 'if-match': etag };
    const results = await Promise.all(
      ['One', 'Two'].map((name) =>
        env.app.inject({
          method: 'PATCH',
          url: `/v1/sessions/${env.sid}`,
          headers,
          payload: { name },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
  });

  it('answers 12 concurrent PATCHes on a pool of 10, one connection each', async () => {
    const env = await setup();
    const headers = await env.as(env.w.owner);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        env.app.inject({
          method: 'PATCH',
          url: `/v1/sessions/${env.sid}`,
          headers,
          payload: { policy: { queue_limit: i + 1 } },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array.from({ length: 12 }, () => 200));
  });

  it('demotes a host a relay-side transfer left out of host_member_id', async () => {
    const env = await setup();
    await env.join(env.w.member);
    // B051's transfer_host: roles swapped, sessions.host_member_id unchanged.
    await db()
      .updateTable('session_members')
      .set({ role: 'editor' })
      .where('session_id', '=', env.sid)
      .where('user_id', '=', env.w.owner.user)
      .execute();
    await db()
      .updateTable('session_members')
      .set({ role: 'host' })
      .where('session_id', '=', env.sid)
      .where('user_id', '=', env.w.member.user)
      .execute();
    const res = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${env.sid}/claim-host`,
      headers: await env.as(env.w.admin),
    });
    expect(res.statusCode).toBe(200);
    const hosts = (await env.members()).filter((r) => r.role === 'host' && r.left_at === null);
    expect(hosts.map((r) => r.user_id)).toEqual([env.w.admin.user]);
  });

  it('gives a kicked member no ticket', async () => {
    const env = await setup();
    await env.join(env.w.member);
    await db()
      .updateTable('session_members')
      .set({ left_at: new Date() })
      .where('session_id', '=', env.sid)
      .where('user_id', '=', env.w.member.user)
      .execute();
    const res = await env.join(env.w.member);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('not_a_member');
  });
});
