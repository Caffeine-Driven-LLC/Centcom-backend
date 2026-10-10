/**
 * Dunning on Postgres 16 (B078 test plan "integration ... (Postgres container)"; DATABASE_URL,
 * CI's integration job): the repository's statements under B070's `billing_subscription`, B069's
 * entitlements, B036's audit table and B072's outbox, through the service.
 *
 * - failure, day-3 reminder, payment, back to active: `past_due_since` moved back to the failure,
 *   `grace_until` 7 days later in the entitlements, the `billing.status` audit event written with
 *   the change, the reminders found by `remindersDue` and marked once, the day-3 notification in
 *   the outbox, then `active` with the grace and the reminders cleared;
 * - failure, grace expiry, none, wind-down: `expiring` finds the workspace, the drop moves `rev`
 *   on, is announced once (notice, outbox webhook, one wind-down job), and the wind-down ends the
 *   sessions; a workspace that paid within the 10 minutes is left alone;
 * - 10 concurrent deliveries of one failure: one transition, one audit event (the advisory lock);
 * - the table's CHECKs refuse a past_due row without its grace, a grace other than 7 days, and a
 *   none row without its time and reason.
 */
import { createAuditEmitter, type AuditDb } from '@centcom/core';
import type { DunningDb, EntitlementsDb, StripeEventsDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createDunningRepository,
  DUNNING_AUDIT_ACTIONS,
  DunningService,
  type BillingEvent,
} from '../../../src/modules/billing/dunning/index.js';
import type { StripeSub } from '../../../src/modules/billing/stripe/gateway.js';
import { createBillingRepository } from '../../../src/modules/billing/subscriptions/repository.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { createOutboxStore } from '../../../src/modules/billing/webhooks/outbox.js';
import {
  createEntitlementRepository,
  EntitlementService,
} from '../../../src/modules/entitlements/index.js';
import { Clock, RecordingPublisher } from '../../entitlements/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import { catalog, FakeStripe } from '../subscriptions/helpers.js';
import { DAY, MIN, recordingScheduler, stripeId, stripeSub } from './helpers.js';

type Db = Kysely<DunningDb & EntitlementsDb & StripeEventsDatabase>;

async function setup() {
  const t = await migratedDatabase(10);
  const db = t.db as unknown as Db;
  // Whole seconds: Stripe's event times are Unix seconds.
  const clock = new Clock(Math.floor(Date.now() / 1000) * 1000);
  const owner = await pgUser(t.db);
  const ws = await pgWorkspace(t.db, owner);
  await pgJoin(t.db, ws, owner, 'owner');
  const billingRepo = createBillingRepository(db);
  const customer = stripeId('cus');
  await billingRepo.linkCustomer(ws, customer);
  const entitlements = new EntitlementService({
    repository: createEntitlementRepository(db as unknown as Kysely<EntitlementsDb>),
    events: new RecordingPublisher(),
    clock: clock.read,
  });
  const billing = new BillingService({
    repository: billingRepo,
    gateway: new FakeStripe(),
    catalog: catalog(),
    entitlements,
    clock: clock.read,
  });
  const repository = createDunningRepository(
    db as unknown as Kysely<DunningDb>,
    createAuditEmitter({ db: db as unknown as AuditDb, actions: DUNNING_AUDIT_ACTIONS }),
  );
  const queue = recordingScheduler();
  const notices: string[] = [];
  const ended: string[] = [];
  const sent: string[] = [];
  const templates = new Set<string>();
  const service = new DunningService({
    repository,
    entitlements,
    billing: billingRepo,
    outbox: createOutboxStore(db as unknown as Kysely<StripeEventsDatabase>),
    notices: {
      publish: (channel) => {
        notices.push(channel);
        return Promise.resolve();
      },
    },
    scheduler: queue.scheduler,
    sessions: {
      endLiveHostedSessions: (id) => {
        ended.push(id);
        return Promise.resolve(1);
      },
    },
    config: { graceDays: 7, windDownMs: 10 * MIN },
    mail: {
      templates: {
        ids: () => [...templates],
        registerTemplate: (id: string) => {
          templates.add(id);
        },
      },
      send: (_id: string, to: string, _p: unknown, opts?: { idempotencyKey?: string }) => {
        if (!sent.includes(opts?.idempotencyKey ?? '')) sent.push(opts?.idempotencyKey ?? '');
        void to;
        return Promise.resolve({ queued: true, jobId: 'job' });
      },
    } as never,
  });
  let sub: StripeSub = stripeSub(customer, { plan: 'team', workspaceId: ws });
  /** Stripe's subscription moves to `status`; B070 stores it from an event created now. */
  const stripeMoves = async (status: string) => {
    sub = { ...sub, status };
    await billing.upsertFromStripe(sub, Math.floor(clock.now / 1000));
  };
  /** Dunning applies a `type` event created at `created` (default now). */
  const apply = (type: string, invoiceId: string | null = null, created = new Date(clock.now)) => {
    const ev: BillingEvent = {
      id: stripeId('evt'),
      type,
      created,
      workspaceId: ws,
      invoiceId,
      objectStatus: null,
    };
    return service.applyBillingEvent(ev, new Date(clock.now));
  };
  /** Runs the queued jobs due now, as the worker would. */
  const runDue = async () => {
    const out: unknown[] = [];
    for (const job of [...queue.jobs.values()].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (job.done || job.at.getTime() > clock.now) continue;
      job.done = true;
      out.push(
        job.name === 'remind' && job.day !== undefined && job.firstFailedAt !== undefined
          ? await service.remind(ws, job.day, job.firstFailedAt, new Date(clock.now))
          : await service.windDown(ws),
      );
    }
    return out;
  };
  const row = () =>
    db
      .selectFrom('subscription_dunning')
      .selectAll()
      .where('workspace_id', '=', ws)
      .executeTakeFirst();
  const audits = async () =>
    (
      await sql<{ action: string; meta: Record<string, unknown> }>`
        select action, meta from audit_events where workspace_id = ${ws} order by created_at, id
      `.execute(db)
    ).rows;
  // Its last change was a month ago.
  await billing.upsertFromStripe(sub, Math.floor((clock.now - 30 * DAY) / 1000));
  return {
    t,
    db,
    clock,
    ws,
    entitlements,
    billing,
    repository,
    queue,
    notices,
    ended,
    sent,
    service,
    stripeMoves,
    apply,
    runDue,
    row,
    audits,
  };
}

describe.runIf(ADMIN_URL !== undefined)('dunning on Postgres 16', () => {
  it('goes from a failure through the day-3 reminder and a payment back to active', async () => {
    const s = await setup();
    try {
      const failedAt = new Date(s.clock.now);
      s.clock.advance(60 * MIN); // the webhook is processed an hour later
      await s.stripeMoves('past_due');
      const invoice = stripeId('in');
      expect(await s.apply('invoice.payment_failed', invoice, failedAt)).toEqual({
        workspace: s.ws,
        from: 'active',
        to: 'past_due',
        grace_until: new Date(failedAt.getTime() + 7 * DAY).toISOString(),
      });
      expect(await s.row()).toMatchObject({
        state: 'past_due',
        failed_invoice: invoice,
        first_failed_at: failedAt,
        grace_until: new Date(failedAt.getTime() + 7 * DAY),
        reminders_sent: 0,
      });
      const subscription = await s.db
        .selectFrom('billing_subscription')
        .select('past_due_since')
        .where('workspace_id', '=', s.ws)
        .executeTakeFirstOrThrow();
      expect(subscription.past_due_since).toEqual(failedAt);
      expect(await s.entitlements.get(s.ws)).toMatchObject({
        status: 'past_due',
        grace_until: new Date(failedAt.getTime() + 7 * DAY).toISOString(),
      });
      expect(await s.audits()).toEqual([
        { action: 'billing.status', meta: { from: 'active', to: 'past_due' } },
      ]);

      await s.runDue(); // day 0
      expect((await s.row())?.reminders_sent).toBe(1);
      s.clock.now = failedAt.getTime() + 3 * DAY + MIN;
      expect(await s.repository.remindersDue(new Date(s.clock.now), 200)).toHaveLength(1);
      expect(await s.service.expire(new Date(s.clock.now))).toMatchObject({ reminders: 1 });
      expect(await s.runDue()).toEqual(['sent']);
      expect((await s.row())?.reminders_sent).toBe(3);
      expect(await s.repository.remindersDue(new Date(s.clock.now), 200)).toEqual([]);
      expect(s.sent).toHaveLength(2);
      const outbox = await s.db
        .selectFrom('billing_outbox')
        .select(['type', 'dedupe_key'])
        .where('workspace_id', '=', s.ws)
        .execute();
      expect(outbox).toContainEqual({
        type: 'notify.billing_issue',
        dedupe_key: `dunning-${s.ws}-${failedAt.getTime()}-day3`,
      });

      s.clock.advance(60 * MIN);
      await s.stripeMoves('active');
      expect(await s.apply('invoice.paid', stripeId('in'))).toMatchObject({
        from: 'past_due',
        to: 'active',
        grace_until: null,
      });
      expect(await s.row()).toMatchObject({
        state: 'active',
        first_failed_at: null,
        grace_until: null,
        reminders_sent: 0,
      });
      expect(await s.entitlements.get(s.ws)).toMatchObject({ status: 'active', grace_until: null });
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('drops to none after the grace, announces it once, and winds down unless paid', async () => {
    const s = await setup();
    try {
      await s.stripeMoves('past_due');
      await s.apply('invoice.payment_failed', stripeId('in'));
      const during = await s.entitlements.get(s.ws);
      const graceUntil = s.clock.now + 7 * DAY;
      s.clock.now = graceUntil + 2 * MIN;
      expect(await s.repository.expiring(new Date(s.clock.now), 200)).toEqual([s.ws]);
      expect(await s.service.expire(new Date(s.clock.now))).toMatchObject({
        expired: 1,
        announced: 1,
      });
      const dropped = await s.row();
      expect(dropped).toMatchObject({
        state: 'none',
        none_reason: 'grace_expired',
        none_at: new Date(s.clock.now),
        announced_at: new Date(s.clock.now),
      });
      expect(await s.entitlements.get(s.ws)).toMatchObject({
        status: 'none',
        plan: 'free',
        rev: (during?.rev ?? 0) + 1,
      });
      expect(s.notices).toEqual([`relay:notice:${s.ws}`]);
      const webhook = await s.db
        .selectFrom('billing_outbox')
        .select(['payload'])
        .where('workspace_id', '=', s.ws)
        .where('dedupe_key', 'like', 'dunning-none-%')
        .execute();
      expect(webhook).toEqual([
        { payload: expect.objectContaining({ plan: 'free', status: 'none' }) },
      ]);
      expect(await s.service.expire(new Date(s.clock.now + 5 * MIN))).toEqual({
        expired: 0,
        announced: 0,
        reminders: 0,
      });
      expect(s.notices).toHaveLength(1);
      expect([...s.queue.jobs.values()].filter((j) => j.name === 'wind-down')).toHaveLength(1);
      expect((await s.audits()).map((a) => a.meta)).toEqual([
        { from: 'active', to: 'past_due' },
        { from: 'past_due', to: 'none', reason: 'grace_expired' },
      ]);

      s.clock.advance(10 * MIN);
      expect(await s.runDue()).toContain(1);
      expect(s.ended).toEqual([s.ws]);

      // Again, but the workspace pays within the 10 minutes: the wind-down does nothing.
      s.clock.advance(MIN);
      await s.stripeMoves('active');
      await s.apply('invoice.paid', stripeId('in'));
      await s.stripeMoves('past_due');
      await s.apply('invoice.payment_failed', stripeId('in'));
      s.clock.advance(7 * DAY + 2 * MIN);
      await s.service.expire(new Date(s.clock.now));
      expect((await s.row())?.state).toBe('none');
      s.clock.advance(3 * MIN);
      await s.stripeMoves('active');
      await s.apply('invoice.paid', stripeId('in'));
      s.clock.advance(10 * MIN);
      expect(await s.runDue()).toContain(0);
      expect(s.ended).toEqual([s.ws]);
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('applies 10 concurrent deliveries of one failure as one', async () => {
    const s = await setup();
    try {
      await s.stripeMoves('past_due');
      const invoice = stripeId('in');
      const created = new Date(s.clock.now);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => s.apply('invoice.payment_failed', invoice, created)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await s.audits()).toHaveLength(1);
      expect((await s.row())?.state).toBe('past_due');
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('refuses rows that break the table rules', async () => {
    const s = await setup();
    try {
      const now = new Date(s.clock.now);
      const insert = (values: Record<string, unknown>) =>
        sql`insert into subscription_dunning (workspace_id, state, first_failed_at, grace_until,
              none_at, none_reason)
            values (${s.ws}, ${values['state']}, ${values['first_failed_at'] ?? null},
              ${values['grace_until'] ?? null}, ${values['none_at'] ?? null},
              ${values['none_reason'] ?? null})`.execute(s.db);
      for (const bad of [
        { state: 'past_due' },
        { state: 'past_due', first_failed_at: now, grace_until: new Date(now.getTime() + 6 * DAY) },
        { state: 'none' },
        { state: 'active', first_failed_at: now, grace_until: new Date(now.getTime() + 7 * DAY) },
        { state: 'unpaid' },
      ]) {
        await expect(insert(bad)).rejects.toThrow();
      }
      await insert({ state: 'none', none_at: now, none_reason: 'period_ended' });
      expect((await s.row())?.state).toBe('none');
    } finally {
      await s.t.drop();
    }
  }, 60_000);
});
