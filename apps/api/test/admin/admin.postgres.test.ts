/**
 * The admin API on Postgres 16 (B087; DATABASE_URL, CI's integration job):
 *
 * - migration 20260102002900: `staff` actors in audit_events, the staff tables' checks;
 * - the store's reads (allowlisted columns only, member and session counts), its transaction (the
 *   event, its details and the writes commit together or not at all), the staff audit by keyset;
 * - the writes: disabling a login, ending a session, staff rows;
 * - B017 with B087: the sign-in gate, and a staff revocation answering `token_revoked` on refresh;
 * - one call end to end through the admin listener on the real store.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { createAuditEmitter, createMemoryRedis } from '@centcom/core';
import type { AdminDatabase, CoreDatabase, TokenDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_ACTIONS,
  AdminService,
  callEvent,
  createAdminStore,
  createLoginGate,
  newCall,
  StaffDirectory,
} from '../../src/modules/admin/index.js';
import { RefreshTokenStore } from '../../src/modules/auth/tokens/index.js';
import { createAdminServer } from '../../src/routes/internal-admin.js';
import { captureLogger } from '../helpers.js';
import { memoryTokens, seedUser } from '../modules/auth/tokens/helpers.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { KEYS } from '../modules/workspaces/helpers.js';
import { StatusRepository } from './helpers.js';
import { MemoryFlagRepository } from '../flags/helpers.js';
import { FlagAdmin } from '../../src/modules/flags/service.js';
import { FLAG_AUDIT_ACTIONS } from '../../src/modules/flags/actions.js';
import { StatusAdmin } from '../../src/modules/status/service.js';

const REASON = 'Checking a support ticket about sign-in';

/** A workspace of `ownerId` with `members`, and a live session with its host and a viewer. */
async function seedWorkspace(db: Kysely<AdminDatabase>, ownerId: string, ownerDevice: string) {
  const workspaceId = newId('wsp');
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      name: 'Acme',
      slug: `acme-${randomBytes(3).toString('hex')}`,
      created_by: ownerId,
    })
    .execute();
  const member = await seedUser(db as unknown as Kysely<CoreDatabase>);
  for (const [userId, role] of [
    [ownerId, 'owner'],
    [member.userId, 'member'],
  ] as const) {
    await db
      .insertInto('memberships')
      .values({ id: newId('mem'), workspace_id: workspaceId, user_id: userId, role })
      .execute();
  }
  const sessionId = newId('ses');
  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      workspace_id: workspaceId,
      name: 'Secret project name',
      region: 'eu',
      created_by: ownerId,
      state: 'live',
    })
    .execute();
  const host = newId('mem');
  await db
    .insertInto('session_members')
    .values([
      {
        id: host,
        session_id: sessionId,
        user_id: ownerId,
        device_id: ownerDevice,
        role: 'host',
        slot: 0,
      },
      {
        id: newId('mem'),
        session_id: sessionId,
        user_id: member.userId,
        device_id: member.deviceId,
        role: 'viewer',
        slot: 1,
      },
      {
        id: newId('mem'),
        session_id: sessionId,
        user_id: member.userId,
        device_id: member.deviceId,
        role: 'editor',
        slot: 2,
        left_at: new Date(),
      },
    ])
    .execute();
  return { workspaceId, sessionId, host, member };
}

describe.runIf(ADMIN_URL !== undefined)('the admin API on Postgres 16', () => {
  it('reads metadata only, with member and session counts', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AdminDatabase>;
      const owner = await seedUser(t.db);
      const { workspaceId, sessionId, host } = await seedWorkspace(
        db,
        owner.userId,
        owner.deviceId,
      );
      const store = createAdminStore({
        db,
        emitter: createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS }),
      });

      const user = await store.reader.user(owner.userId);
      expect(Object.keys(user ?? {}).sort()).toEqual(
        [
          'created_at',
          'deletion_requested_at',
          'display_name',
          'email',
          'id',
          'login_disabled_at',
          'status',
        ].sort(),
      );
      const email = user?.email ?? '';
      expect((await store.reader.userByEmail(email.toUpperCase()))?.id).toBe(owner.userId);
      const devices = await store.reader.devices(owner.userId);
      expect(devices).toHaveLength(1);
      expect(Object.keys(devices[0] ?? {}).sort()).toEqual(
        ['created_at', 'id', 'last_seen_at', 'name', 'platform', 'revoked_at'].sort(),
      );
      expect(await store.reader.memberships(owner.userId)).toEqual([
        expect.objectContaining({ workspace_id: workspaceId, role: 'owner' }),
      ]);
      const members = await store.reader.members(workspaceId, 1);
      expect(members.total).toBe(2);
      expect(members.rows).toEqual([
        expect.objectContaining({ user_id: owner.userId, role: 'owner', email }),
      ]);
      const session = await store.reader.session(sessionId);
      expect(session).toEqual({
        id: sessionId,
        workspace_id: workspaceId,
        state: 'live',
        region: 'eu',
        created_at: expect.any(Date) as unknown,
        ended_at: null,
        member_count: 2,
        host_member: host,
      });
      expect(JSON.stringify(session)).not.toContain('Secret project');
      expect(await store.reader.session(newId('ses'))).toBeNull();
    } finally {
      await t.drop();
    }
  });

  it('commits a call’s event, reason and ticket with its writes, or nothing; lists them by keyset', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AdminDatabase>;
      const staff = await seedUser(t.db);
      const target = await seedUser(t.db);
      const store = createAdminStore({
        db,
        emitter: createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS }),
      });
      const event = (route: string) => {
        const call = newCall(newId('req'), 'POST', route);
        call.actor = { type: 'staff', id: staff.userId };
        call.staff = { userId: staff.userId, role: 'superadmin' };
        call.target = { type: 'user', id: target.userId };
        return callEvent(call, 'success', 200, null);
      };

      const id = await store.transaction(async (tx) => {
        const auditId = await tx.record(event('/internal/admin/v1/users/:id/disable'), {
          reason: REASON,
          ticket: 'SUP-1',
        });
        await tx.disableLogin(target.userId, new Date());
        return auditId;
      });
      await expect(
        store.transaction(async (tx) => {
          await tx.record(event('/internal/admin/v1/users/:id/revoke-tokens'), {
            reason: REASON,
            ticket: null,
          });
          await tx.putStaff(target.userId, 'support_ro', staff.userId, new Date());
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await store.reader.staff(target.userId)).toBeNull();

      for (let i = 0; i < 3; i += 1) {
        await store.transaction((tx) =>
          tx.record(event('/internal/admin/v1/users/:id'), { reason: REASON, ticket: null }),
        );
      }
      const first = await store.reader.staffAudit({ limit: 2 });
      expect(first).toHaveLength(2);
      const last = first[1];
      const rest = await store.reader.staffAudit({
        limit: 10,
        ...(last === undefined
          ? {}
          : { after: { at: last.created_at.toISOString(), id: last.id } }),
      });
      expect(rest).toHaveLength(2);
      const all = [...first, ...rest];
      expect(new Set(all.map((r) => r.id)).size).toBe(4);
      expect(all.find((r) => r.id === id)).toMatchObject({
        actor_type: 'staff',
        actor_id: staff.userId,
        outcome: 'success',
        target_type: 'user',
        target_id: target.userId,
        reason: REASON,
        ticket: 'SUP-1',
        meta: expect.objectContaining({
          route: '/internal/admin/v1/users/:id/disable',
          role: 'superadmin',
        }) as unknown,
      });
      expect(await store.reader.staffAudit({ limit: 10, actor: newId('usr') })).toEqual([]);
      expect(await store.reader.staffAudit({ limit: 10, target: target.userId })).toHaveLength(4);
      const { rows } = await sql<{
        n: string;
      }>`select count(*) as n from staff_audit_details`.execute(db);
      expect(Number(rows[0]?.n)).toBe(4);
    } finally {
      await t.drop();
    }
  });

  it('disables logins, ends sessions, and adds, changes and disables staff', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AdminDatabase>;
      const owner = await seedUser(t.db);
      const boss = await seedUser(t.db);
      const { sessionId } = await seedWorkspace(db, owner.userId, owner.deviceId);
      const store = createAdminStore({
        db,
        emitter: createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS }),
      });
      const at = new Date('2026-10-08T12:00:00.000Z');
      await store.transaction(async (tx) => {
        expect(await tx.disableLogin(owner.userId, at)).toEqual(at);
        expect(await tx.disableLogin(owner.userId, new Date())).toEqual(at);
        expect(await tx.disableLogin(newId('usr'), at)).toBeNull();
        expect(await tx.endSession(sessionId, at)).toBe(true);
        expect(await tx.endSession(newId('ses'), at)).toBe(false);
        expect(await tx.putStaff(owner.userId, 'support_rw', boss.userId, at)).toMatchObject({
          role: 'support_rw',
          added_by: boss.userId,
          disabled_at: null,
        });
        expect(await tx.disableStaff(owner.userId, at)).toMatchObject({ disabled_at: at });
        expect(
          await tx.putStaff(owner.userId, 'superadmin', boss.userId, new Date()),
        ).toMatchObject({
          role: 'superadmin',
          disabled_at: null,
        });
        expect(await tx.disableStaff(newId('usr'), at)).toBeNull();
      });
      expect(await store.reader.session(sessionId)).toMatchObject({ state: 'ended', ended_at: at });
      await expect(createLoginGate(db).assertCanSignIn(owner.userId)).rejects.toMatchObject({
        code: 'access_denied',
        status: 403,
      });
      await expect(createLoginGate(db).assertCanSignIn(boss.userId)).resolves.toBeUndefined();
    } finally {
      await t.drop();
    }
  });

  it('takes staff actors in audit_events and checks the staff tables', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AdminDatabase>;
      const user = await seedUser(t.db);
      const emitter = createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS });
      const call = newCall(newId('req'), 'GET', '/internal/admin/v1/staff-audit');
      call.actor = { type: 'staff', id: user.userId };
      await expect(
        db.transaction().execute((trx) => emitter.emit(trx, callEvent(call, 'success', 200, null))),
      ).resolves.toMatch(/^aud_/);
      await expect(
        sql`insert into staff_users (user_id, role) values (${user.userId}, 'owner')`.execute(db),
      ).rejects.toMatchObject({ code: '23514', constraint: 'staff_users_role_check' });
      await expect(
        sql`insert into staff_users (user_id, role) values (${newId('usr')}, 'support_ro')`.execute(
          db,
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        sql`insert into staff_audit_details (audit_id, reason) values (${newId('aud')}, 'too short')`.execute(
          db,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // A valid row but for its reason: only revoked_reason's check can refuse it.
      const refresh = (reason: string) =>
        sql`insert into refresh_tokens (token_hash, family_id, user_id, client_id, scope, expires_at, absolute_expires_at, revoked_reason)
            values (${randomBytes(32).toString('hex')}, ${randomBytes(16).toString('hex')}, ${user.userId},
                    'centcom-cli', 'profile', now(), now(), ${reason})`.execute(db);
      await expect(refresh('logout')).rejects.toMatchObject({
        code: '23514',
        constraint: 'refresh_tokens_revoked_reason_check',
      });
      await expect(refresh('staff')).resolves.toBeDefined();
    } finally {
      await t.drop();
    }
  });

  it('answers token_revoked on refresh after a staff revocation, for that user only', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<TokenDatabase>;
      const target = await seedUser(t.db);
      const other = await seedUser(t.db);
      const store = new RefreshTokenStore({ db, now: Date.now });
      const grant = (userId: string, deviceId: string) => ({
        userId,
        deviceId,
        clientId: 'centcom-cli' as const,
        scope: 'profile',
        workspaceId: null,
      });
      const mine = await store.issue(grant(target.userId, target.deviceId));
      const theirs = await store.issue(grant(other.userId, other.deviceId));
      expect(await store.revokeUser(target.userId)).toBe(1);
      expect(await store.revokeUser(target.userId)).toBe(0);
      await expect(store.rotate(mine, 'centcom-cli')).rejects.toMatchObject({
        code: 'token_revoked',
        status: 401,
      });
      await expect(store.rotate(theirs, 'centcom-cli')).resolves.toMatchObject({
        grant: expect.objectContaining({ userId: other.userId }) as unknown,
      });
    } finally {
      await t.drop();
    }
  });

  it('serves a call end to end on the real store', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<AdminDatabase>;
      const captured = captureLogger();
      const staffUser = await seedUser(t.db);
      const target = await seedUser(t.db);
      await db
        .insertInto('staff_users')
        .values({ user_id: staffUser.userId, role: 'support_rw' })
        .execute();
      const store = createAdminStore({
        db,
        emitter: createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS }),
      });
      const { tokens } = memoryTokens({ signInGate: createLoginGate(db) });
      const redis = createMemoryRedis();
      const directory = new StaffDirectory({ reader: store.reader });
      const service = new AdminService({
        store,
        tokens,
        directory,
        flags: new FlagAdmin({
          repository: new MemoryFlagRepository(),
          emitter: createAuditEmitter({ db, actions: FLAG_AUDIT_ACTIONS }),
          pubsub: redis.pubsub,
          config: { maxCount: 10, maxValueBytes: 1024 },
        }),
        status: new StatusAdmin({ repository: new StatusRepository(), components: [] }),
        cursorKeys: KEYS,
      });
      const app = await createAdminServer({
        service,
        store,
        access: { tokens, directory, rateLimit: redis.rateLimit },
        allowedCidrs: [{ address: '127.0.0.0', prefix: 8, family: 'ipv4' }],
        logger: captured.logger,
      });
      try {
        const { access_token: token } = await tokens.issueTokens({
          userId: staffUser.userId,
          deviceId: null,
          scopes: ['admin'],
        });
        const headers = { authorization: `Bearer ${token}`, 'x-admin-reason': REASON };
        const read = await app.inject({
          method: 'GET',
          url: `/internal/admin/v1/users/${target.userId}`,
          headers,
        });
        expect(read.statusCode).toBe(200);
        const disable = await app.inject({
          method: 'POST',
          url: `/internal/admin/v1/users/${target.userId}/disable`,
          headers,
        });
        expect(disable.statusCode).toBe(200);
        await expect(
          tokens.issueTokens({ userId: target.userId, deviceId: null, scopes: ['profile'] }),
        ).rejects.toMatchObject({ code: 'access_denied' });
        const audit = await app.inject({
          method: 'GET',
          url: '/internal/admin/v1/staff-audit',
          headers,
        });
        const listed = (audit.json() as { data: { route: string; reason: string }[] }).data;
        // Two events, possibly in the same millisecond: compare without order.
        expect(listed).toHaveLength(2);
        expect(listed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              route: '/internal/admin/v1/users/:id/disable',
              reason: REASON,
            }),
            expect.objectContaining({ route: '/internal/admin/v1/users/:id', reason: REASON }),
          ]),
        );
      } finally {
        await app.close();
      }
    } finally {
      await t.drop();
    }
  });
});
