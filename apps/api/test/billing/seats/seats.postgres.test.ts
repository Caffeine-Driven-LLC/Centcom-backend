/**
 * Seats on Postgres 16 (B073 guardrail "check and Stripe update MUST be serialised per workspace
 * (advisory lock) to avoid racing invites", failure mode "Invite accepted concurrently while
 * decreasing seats -> lock makes one of them win; loser gets 409"; DATABASE_URL, CI's integration
 * job), with B030's gate (its limit read from the stored subscription, as B069 derives
 * `max_seats` from it), B070's repository and a fake Stripe:
 *
 * - a seat change holds the workspace's lock across the Stripe call: B030's gate (an add, in its
 *   own transaction) waits until the change is done;
 * - an add that starts during a decrease to the seats in use waits, then is refused (403
 *   `seat_limit_reached`) against the lowered limit: one of them wins;
 * - an add holding B030's lock first: the decrease waits, then counts the new member and is a 409
 *   with no Stripe call;
 * - a preview leaves the stored row as it was;
 * - the lock staying taken past SEAT_LOCK_WAIT_MS (an injected clock): 503 with `Retry-After: 1`;
 *   the lock is released when the work throws, with the work's own error;
 * - `seatAccountingFrom` counts members and pending invites on the locked connection;
 * - `createReconcileSource` pages Team workspaces with a subscription in effect, by id.
 */
import { randomBytes } from 'node:crypto';
import { isAppError } from '@centcom/core';
import type { BillingDb, CoreDatabase, InviteDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createSeatLock,
  SEAT_LOCK_WAIT_MS,
  seatAccountingFrom,
} from '../../../src/modules/billing/seats/ports.js';
import { createReconcileSource } from '../../../src/modules/billing/seats/reconcile.js';
import type { StripeSub } from '../../../src/modules/billing/stripe/gateway.js';
import { SeatService } from '../../../src/modules/billing/seats/service.js';
import { createBillingRepository } from '../../../src/modules/billing/subscriptions/repository.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import {
  createSeatGate,
  SeatService as SeatUsageService,
} from '../../../src/modules/seats/index.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import { catalog, FakeStripe } from '../subscriptions/helpers.js';
import { FakeSeatStripe, newId, stripeId, stripeSub } from './helpers.js';

/** A Team workspace with `members` seat-taking members (owner included) and `addonSeats`. */
async function setup(members: number, addonSeats: number) {
  const t = await migratedDatabase(10);
  const db = t.db as unknown as Kysely<BillingDb>;
  const owner = await pgUser(t.db);
  const ws = await pgWorkspace(t.db, owner);
  await pgJoin(t.db, ws, owner, 'owner');
  for (let i = 1; i < members; i += 1) await pgJoin(t.db, ws, await pgUser(t.db), 'member');
  const repository = createBillingRepository(db);
  const customer = stripeId('cus');
  await repository.linkCustomer(ws, customer);
  const billing = new BillingService({ repository, gateway: new FakeStripe(), catalog: catalog() });
  const sub = stripeSub(customer, { addonSeats });
  await billing.upsertFromStripe(sub, 100);
  const stripe = new FakeSeatStripe();
  stripe.subscriptions.set(sub.id, structuredClone(sub));
  const usage = new SeatUsageService({ db: t.db });
  const service = new SeatService({
    billingRepository: repository,
    billing,
    stripe,
    catalog: catalog(),
    seats: seatAccountingFrom(usage),
    lock: createSeatLock(t.db),
  });
  const gate = createSeatGate({
    seats: usage,
    // max_seats as B069 derives it for Team: the stored seats.
    limits: { maxSeats: async (w) => (await repository.findSubscription(w))?.seats ?? 1 },
  });
  /** An add through B030's gate in its own transaction; `hold` keeps it open after the insert. */
  const add = (hold?: Promise<void>, onLocked?: () => void) =>
    t.db.transaction().execute(async (trx) => {
      await gate.assertCanAdd(trx, ws);
      onLocked?.();
      const user = newId('usr');
      await trx
        .insertInto('users')
        .values({ id: user, email: `${user.toLowerCase()}@example.test`, display_name: 'New' })
        .execute();
      await trx
        .insertInto('memberships')
        .values({ id: newId('mem'), workspace_id: ws, user_id: user, role: 'member' })
        .execute();
      if (hold !== undefined) await hold;
    });
  const ctx = { requestId: newId('req'), audit: () => undefined };
  const actor = { kind: 'user' as const, userId: owner, scopes: ['billing:write'] };
  return { t, db, ws, owner, repository, stripe, service, usage, add, ctx, actor, sub };
}

const latch = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe.runIf(ADMIN_URL !== undefined)('seat changes on Postgres 16', () => {
  it('makes an add through B030 wait while a change holds the lock across Stripe', async () => {
    const s = await setup(5, 2);
    try {
      const stripeGate = latch();
      s.stripe.gate = stripeGate.opened;
      const order: string[] = [];
      const change = s.service.change(s.ws, s.actor, 6, s.ctx).then((r) => {
        order.push('change');
        return r;
      });
      await until(() => s.stripe.writes().length === 1);
      const adding = s.add().then(() => order.push('add'));
      await new Promise((r) => setTimeout(r, 300));
      expect(order).toEqual([]);
      stripeGate.open();
      expect(await change).toEqual({ seats: 6, preview: false, proration: null });
      await adding;
      expect(order).toEqual(['change', 'add']);
      expect((await s.repository.findSubscription(s.ws))?.seats).toBe(6);
      expect((await s.usage.usage(s.ws)).total).toBe(6);
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('refuses an add that started during a decrease, against the lowered limit', async () => {
    const s = await setup(6, 3);
    try {
      const stripeGate = latch();
      s.stripe.gate = stripeGate.opened;
      const change = s.service.change(s.ws, s.actor, 6, s.ctx);
      await until(() => s.stripe.writes().length === 1);
      // The add reads max_seats 8 and waits for the lock the decrease holds.
      const adding = s.add().then(
        () => 'added',
        (err: unknown) => (isAppError(err) ? `${err.status} ${err.code}` : String(err)),
      );
      await new Promise((r) => setTimeout(r, 300));
      stripeGate.open();
      expect(await change).toMatchObject({ seats: 6 });
      expect(await adding).toBe('403 seat_limit_reached');
      expect((await s.usage.usage(s.ws)).total).toBe(6);
      expect((await s.repository.findSubscription(s.ws))?.seats).toBe(6);
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('leaves the stored row as it was on a preview', async () => {
    const s = await setup(5, 2);
    try {
      const before = await s.db.selectFrom('billing_subscription').selectAll().execute();
      expect(await s.service.preview(s.ws, 9)).toMatchObject({ seats: 9, preview: true });
      expect(await s.db.selectFrom('billing_subscription').selectAll().execute()).toEqual(before);
      expect(s.stripe.writes()).toHaveLength(0);
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('counts an add that held the lock first, and refuses the decrease with 409', async () => {
    const s = await setup(5, 1);
    try {
      const hold = latch();
      const locked = latch();
      const adding = s.add(hold.opened, locked.open);
      await locked.opened;
      const change = s.service.change(s.ws, s.actor, 5, s.ctx).then(
        () => 'changed',
        (err: unknown) =>
          isAppError(err) ? `${err.status} ${err.errors?.[0]?.code}` : String(err),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(s.stripe.calls).toHaveLength(0);
      hold.open();
      await adding;
      expect(await change).toBe('409 seats_in_use');
      expect(s.stripe.calls).toHaveLength(0);
      expect((await s.repository.findSubscription(s.ws))?.seats).toBe(6);
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('answers 503 with Retry-After 1 when the lock stays taken, and frees it after a throw', async () => {
    const s = await setup(1, 0);
    try {
      const lock = createSeatLock(s.t.db);
      const hold = latch();
      const holding = latch();
      const holder = lock.withWorkspaceLock(s.ws, async () => {
        holding.open();
        await hold.opened;
      });
      await holding.opened;
      let now = 0;
      const waiting = createSeatLock(s.t.db, {
        clock: () => now,
        sleep: () => {
          now += SEAT_LOCK_WAIT_MS;
          return Promise.resolve();
        },
      });
      const refused = await waiting
        .withWorkspaceLock(s.ws, () => Promise.resolve('ran'))
        .catch((e: unknown) => e);
      expect(isAppError(refused) && refused.status).toBe(503);
      expect(isAppError(refused) && refused.retryAfterS).toBe(1);
      hold.open();
      await holder;

      const boom = new Error('boom');
      const thrown = await lock
        .withWorkspaceLock(s.ws, () => Promise.reject(boom))
        .catch((e: unknown) => e);
      expect(thrown).toBe(boom);
      expect(await lock.withWorkspaceLock(s.ws, () => Promise.resolve('again'))).toBe('again');
      const left = await sql<{ n: string }>`
        select count(*)::text as n from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())
      `.execute(s.t.db);
      expect(left.rows[0]?.n).toBe('0');
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('counts members and pending invites on the locked connection', async () => {
    const s = await setup(3, 0);
    try {
      const invites = s.t.db as unknown as Kysely<InviteDatabase>;
      await invites
        .insertInto('invites')
        .values({
          id: newId('inv'),
          workspace_id: s.ws,
          email: null,
          role: 'member',
          token_hash: randomBytes(32),
          created_by: s.owner,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .execute();
      const accounting = seatAccountingFrom(s.usage);
      const lock = createSeatLock(s.t.db);
      expect(await lock.withWorkspaceLock(s.ws, (db) => accounting.seatsInUse(s.ws, db))).toBe(4);
      expect(await accounting.seatsInUse(s.ws)).toBe(4);
    } finally {
      await s.t.drop();
    }
  }, 30_000);

  it('pages Team workspaces with a subscription in effect, by id', async () => {
    const s = await setup(1, 0);
    try {
      const core = s.t.db as unknown as Kysely<CoreDatabase>;
      const billing = new BillingService({
        repository: s.repository,
        gateway: new FakeStripe(),
        catalog: catalog(),
      });
      const team = [s.ws];
      const kinds: [StripeSub['status'], 'pro' | 'team', boolean][] = [
        ['trialing', 'team', true],
        ['past_due', 'team', true],
        ['canceled', 'team', false],
        ['active', 'pro', false],
      ];
      for (const [status, plan, counted] of kinds) {
        const owner = await pgUser(core);
        const ws = await pgWorkspace(core, owner);
        const customer = stripeId('cus');
        await s.repository.linkCustomer(ws, customer);
        await billing.upsertFromStripe(stripeSub(customer, { plan, status }), 100);
        if (counted) team.push(ws);
      }
      team.sort();
      const source = createReconcileSource(s.db);
      expect(await source.teamWorkspaces(null, 10)).toEqual(team);
      expect(await source.teamWorkspaces(null, 2)).toEqual(team.slice(0, 2));
      expect(await source.teamWorkspaces(team[1] ?? null, 2)).toEqual(team.slice(2));
    } finally {
      await s.t.drop();
    }
  }, 30_000);
});
