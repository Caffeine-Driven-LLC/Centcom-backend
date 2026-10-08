/**
 * Seats on Postgres 16 (B030 acceptance 1, 2, 4 and 6; tests "seats.concurrency.test.ts" and the
 * expiry boundary of "seats.gate.test.ts"; DATABASE_URL, CI's integration job):
 *
 * - the count: seat-taking roles only; pending invites only (accepted, revoked, expired and
 *   deleted-workspace invites do not count), and an invite stops counting at `expires_at` on the
 *   service's clock;
 * - 20 concurrent transactions, each `assertCanAdd` then insert, against one free seat: exactly 1
 *   commits and 19 are refused (`pg_advisory_xact_lock(hashtext(workspace_id))`);
 * - a lock held longer than 5 s: the waiting add gets 503 with `Retry-After`, and the caller's
 *   `lock_timeout` is put back after a successful lock;
 * - `usage()` p95 under 20 ms with 50 members and 100 invites; the partial index exists.
 */
import { randomBytes } from 'node:crypto';
import { isAppError } from '@centcom/core';
import type { CoreDatabase, InviteDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createSeatGate,
  SEAT_LOCK_TIMEOUT_MS,
  SeatService,
  seatLimitsFrom,
} from '../../../src/modules/seats/index.js';
import { testClock } from '../auth/tokens/helpers.js';
import { ADMIN_URL, migratedDatabase, newId } from '../users/helpers.js';
import { fixtureEntitlements } from './helpers.js';

type Role = 'owner' | 'admin' | 'member' | 'billing' | 'guest';

async function newUser(db: Kysely<CoreDatabase>): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Seat Tester' })
    .execute();
  return id;
}

async function newWorkspace(db: Kysely<CoreDatabase>, owner: string): Promise<string> {
  const id = newId('wsp');
  await db
    .insertInto('workspaces')
    .values({ id, name: 'Seats', slug: `seats-${id.slice(-10).toLowerCase()}`, created_by: owner })
    .execute();
  await db
    .insertInto('memberships')
    .values({ id: newId('mem'), workspace_id: id, user_id: owner, role: 'owner' })
    .execute();
  return id;
}

async function addMember(db: Kysely<CoreDatabase>, workspaceId: string, role: Role): Promise<void> {
  const userId = await newUser(db);
  await db
    .insertInto('memberships')
    .values({ id: newId('mem'), workspace_id: workspaceId, user_id: userId, role })
    .execute();
}

async function addInvite(
  db: Kysely<CoreDatabase>,
  workspaceId: string,
  createdBy: string,
  values: {
    role?: Exclude<Role, 'owner'>;
    expiresAt: Date;
    accepted?: boolean;
    revoked?: boolean;
    expired?: boolean;
  },
): Promise<void> {
  const invites = db as unknown as Kysely<InviteDatabase>;
  const id = newId('inv');
  await invites
    .insertInto('invites')
    .values({
      id,
      workspace_id: workspaceId,
      email: null,
      role: values.role ?? 'member',
      token_hash: randomBytes(32),
      created_by: createdBy,
      expires_at: values.expiresAt,
    })
    .execute();
  // Accepted, revoked and expired are later states: the schema only lets them be updated in.
  const at = new Date();
  const accepter = values.accepted === true ? await newUser(db) : null;
  if (accepter !== null) {
    await invites
      .updateTable('invites')
      .set({ accepted_at: at, accepted_by: accepter })
      .where('id', '=', id)
      .execute();
  }
  if (values.revoked === true) {
    await invites.updateTable('invites').set({ revoked_at: at }).where('id', '=', id).execute();
  }
  if (values.expired === true) {
    await invites.updateTable('invites').set({ expired_at: at }).where('id', '=', id).execute();
  }
}

describe.runIf(ADMIN_URL !== undefined)('seats on Postgres 16', () => {
  it('counts seat-taking members and pending invites, until the instant they expire', async () => {
    const t = await migratedDatabase(5);
    try {
      const clock = testClock();
      const now = new Date(clock.now());
      const hour = 60 * 60 * 1000;
      const owner = await newUser(t.db);
      const wsp = await newWorkspace(t.db, owner);
      await addMember(t.db, wsp, 'admin');
      await addMember(t.db, wsp, 'member');
      await addMember(t.db, wsp, 'member');
      await addMember(t.db, wsp, 'guest');
      await addMember(t.db, wsp, 'billing');
      const soon = new Date(now.getTime() + 1000);
      await addInvite(t.db, wsp, owner, { expiresAt: soon });
      await addInvite(t.db, wsp, owner, {
        expiresAt: new Date(now.getTime() + hour),
        role: 'guest',
      });
      await addInvite(t.db, wsp, owner, {
        expiresAt: new Date(now.getTime() + hour),
        accepted: true,
      });
      await addInvite(t.db, wsp, owner, {
        expiresAt: new Date(now.getTime() + hour),
        revoked: true,
      });
      await addInvite(t.db, wsp, owner, {
        expiresAt: new Date(now.getTime() + hour),
        expired: true,
      });
      await addInvite(t.db, wsp, owner, { expiresAt: new Date(now.getTime() - 1) });

      const seats = new SeatService({ db: t.db, now: clock.now });
      expect(await seats.usage(wsp)).toEqual({ members: 4, pending_invites: 1, total: 5 });
      clock.advance(999);
      expect((await seats.usage(wsp)).pending_invites).toBe(1);
      clock.advance(1);
      expect(await seats.usage(wsp)).toEqual({ members: 4, pending_invites: 0, total: 4 });

      // A deleted workspace's invites never count.
      const gone = await newWorkspace(t.db, owner);
      await addInvite(t.db, gone, owner, { expiresAt: new Date(clock.now() + hour) });
      expect((await seats.usage(gone)).pending_invites).toBe(1);
      await t.db
        .updateTable('workspaces')
        .set({ deleted_at: new Date() })
        .where('id', '=', gone)
        .execute();
      expect((await seats.usage(gone)).pending_invites).toBe(0);

      // The partial index of this lane's migration.
      const index = await sql<{ indexdef: string }>`
        select indexdef from pg_indexes where indexname = 'invites_workspace_id_pending_idx'
      `.execute(t.db);
      expect(index.rows[0]?.indexdef).toContain('WHERE');
    } finally {
      await t.drop();
    }
  });

  it('lets exactly 1 of 20 concurrent adds take the last seat', async () => {
    const t = await migratedDatabase(25);
    try {
      const owner = await newUser(t.db);
      const wsp = await newWorkspace(t.db, owner);
      await addMember(t.db, wsp, 'member');
      await addMember(t.db, wsp, 'member');
      await addMember(t.db, wsp, 'member');
      // 4 seats taken (owner + 3), max_seats 5: one free.
      const gate = createSeatGate({
        seats: new SeatService({ db: t.db }),
        limits: seatLimitsFrom(fixtureEntitlements('team')),
      });
      const joiners = await Promise.all(Array.from({ length: 20 }, () => newUser(t.db)));
      const results = await Promise.all(
        joiners.map((userId) =>
          t.db
            .transaction()
            .execute(async (trx) => {
              await gate.assertCanAdd(trx, wsp);
              await trx
                .insertInto('memberships')
                .values({ id: newId('mem'), workspace_id: wsp, user_id: userId, role: 'member' })
                .execute();
            })
            .then(
              () => 'added',
              (err: unknown) => (isAppError(err) ? err.code : String(err)),
            ),
        ),
      );
      expect(results.filter((r) => r === 'added')).toHaveLength(1);
      expect(results.filter((r) => r === 'seat_limit_reached')).toHaveLength(19);
      const members = await t.db
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', wsp)
        .executeTakeFirstOrThrow();
      expect(Number(members.n)).toBe(5);
    } finally {
      await t.drop();
    }
  });

  it('answers 503 after waiting 5 s for the lock, and restores lock_timeout after taking it', async () => {
    const t = await migratedDatabase(5);
    try {
      const owner = await newUser(t.db);
      const wsp = await newWorkspace(t.db, owner);
      const gate = createSeatGate({
        seats: new SeatService({ db: t.db }),
        limits: seatLimitsFrom(fixtureEntitlements('team')),
      });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = t.db.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '123s'`.execute(trx);
        await gate.assertCanAdd(trx, wsp);
        const setting = await sql<{ lock_timeout: string }>`show lock_timeout`.execute(trx);
        expect(setting.rows[0]?.lock_timeout).toBe('123s');
        locked();
        await held;
      });
      await holding;
      const started = Date.now();
      const waited = await t.db
        .transaction()
        .execute((trx) => gate.assertCanAdd(trx, wsp))
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      const elapsed = Date.now() - started;
      release();
      await holder;
      expect(isAppError(waited) && waited.status).toBe(503);
      expect(isAppError(waited) && waited.retryAfterS).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(SEAT_LOCK_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(SEAT_LOCK_TIMEOUT_MS + 3000);
    } finally {
      await t.drop();
    }
  }, 20_000);

  it('counts in under 20 ms (p95) with 50 members and 100 invites', async () => {
    const t = await migratedDatabase(5);
    try {
      const owner = await newUser(t.db);
      const wsp = await newWorkspace(t.db, owner);
      for (let i = 0; i < 49; i += 1) await addMember(t.db, wsp, i % 2 === 0 ? 'member' : 'guest');
      const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
      for (let i = 0; i < 100; i += 1) {
        await addInvite(t.db, wsp, owner, {
          expiresAt: later,
          accepted: i % 10 === 0,
          revoked: i % 10 === 1,
        });
      }
      const seats = new SeatService({ db: t.db });
      for (let i = 0; i < 5; i += 1) await seats.usage(wsp);
      const times: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const start = performance.now();
        await seats.usage(wsp);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
      expect(p95).toBeLessThan(20);
      expect(await seats.usage(wsp)).toEqual({ members: 26, pending_invites: 80, total: 106 });
    } finally {
      await t.drop();
    }
  }, 30_000);
});
