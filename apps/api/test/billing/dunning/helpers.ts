/**
 * Fixtures for the dunning tests (B078), in memory, wired as production wires them:
 *
 * - `MemoryDunningRepository`: the repository's rules over B070's in-memory subscriptions (one
 *   change at a time per call, like the advisory lock), with the audit events it wrote;
 * - `recordingScheduler`: the `dunning` queue: jobs by id (a job id queued again is ignored, as
 *   BullMQ does while it is kept), `runDue(now)` runs the ones due (the worker);
 * - `dunningHarness()`: real B070 (`BillingService`), real B069 (`EntitlementService` over its
 *   in-memory repository), B072's `EventProcessor` with dunning plugged in, its outbox and
 *   publisher, a fake Stripe, recorded notices, emails, webhooks, notifications and session ends.
 *   `deliver(type, object, created)` stores and processes a Stripe event (`replay` processes a
 *   stored one again); `customer()` makes a Team workspace with an active subscription.
 */
import type { AuditEvent, NotificationEvent, WebhookEventInput } from '@centcom/core';
import {
  dueReminders,
  DunningService,
  type DunningRepository,
  type DunningRow,
  type DunningScheduler,
  type ReminderDay,
} from '../../../src/modules/billing/dunning/index.js';
import type { StripeSub } from '../../../src/modules/billing/stripe/gateway.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import type { SubscriptionRow } from '../../../src/modules/billing/subscriptions/repository.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { reduceObject } from '../../../src/modules/billing/webhooks/handlers.js';
import { publishOutbox } from '../../../src/modules/billing/webhooks/outbox.js';
import { EventProcessor } from '../../../src/modules/billing/webhooks/processor.js';
import { serviceHarness } from '../../entitlements/helpers.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import {
  catalog,
  contact,
  memoryBilling,
  newId,
  stripeId,
  stripeSub,
} from '../subscriptions/helpers.js';
import { MemoryEventStore, MemoryOutbox } from '../webhooks/helpers.js';

export { newId, stripeId, stripeSub };

export const DAY = 24 * 60 * 60 * 1000;
export const MIN = 60 * 1000;

const copyRow = (row: DunningRow): DunningRow => structuredClone(row);

/** The dunning repository in memory (see the module comment). */
export class MemoryDunningRepository implements DunningRepository {
  rows = new Map<string, DunningRow>();
  audits: AuditEvent<string>[] = [];
  #turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly subscriptions: Map<string, SubscriptionRow>) {}

  find(workspaceId: string): Promise<DunningRow | null> {
    const row = this.rows.get(workspaceId);
    return Promise.resolve(row === undefined ? null : copyRow(row));
  }

  apply: DunningRepository['apply'] = (workspaceId, decide, auditOf) => {
    const run = () => {
      const row = this.rows.get(workspaceId);
      const sub = this.subscriptions.get(workspaceId);
      const decision = decide(
        row === undefined ? null : copyRow(row),
        sub === undefined
          ? null
          : { status: sub.status, pastDueSince: sub.pastDueSince, periodEnd: sub.periodEnd },
      );
      if (decision.next !== null) this.rows.set(workspaceId, copyRow(decision.next));
      const event = auditOf(decision);
      if (event !== null) this.audits.push(event);
      return Promise.resolve(decision);
    };
    const result = this.#turn.then(run, run);
    this.#turn = result.catch(() => undefined);
    return result;
  };

  expiring(now: Date, limit: number): Promise<string[]> {
    const end = (r: DunningRow) => (r.graceUntil ?? r.periodEnd)?.getTime() ?? 0;
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            (r.state === 'past_due' && r.graceUntil !== null && r.graceUntil < now) ||
            (r.state === 'canceled' && r.periodEnd !== null && r.periodEnd < now),
        )
        .sort((a, b) => end(a) - end(b))
        .slice(0, limit)
        .map((r) => r.workspaceId),
    );
  }

  unannounced(limit: number): Promise<DunningRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.state === 'none' && r.announcedAt === null)
        .sort((a, b) => (a.noneAt?.getTime() ?? 0) - (b.noneAt?.getTime() ?? 0))
        .slice(0, limit)
        .map(copyRow),
    );
  }

  markAnnounced(workspaceId: string, noneAt: Date, at: Date): Promise<boolean> {
    const row = this.rows.get(workspaceId);
    if (
      row?.state !== 'none' ||
      row.noneAt?.getTime() !== noneAt.getTime() ||
      row.announcedAt !== null
    ) {
      return Promise.resolve(false);
    }
    row.announcedAt = at;
    return Promise.resolve(true);
  }

  remindersDue(now: Date, limit: number, after: DunningRow | null = null): Promise<DunningRow[]> {
    const key = (r: DunningRow): [number, string] => [
      r.firstFailedAt?.getTime() ?? 0,
      r.workspaceId,
    ];
    const before = (a: [number, string], b: [number, string]) =>
      a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => dueReminders(r, now).length > 0)
        .filter((r) => after === null || before(key(after), key(r)))
        .sort((a, b) => (before(key(a), key(b)) ? -1 : 1))
        .slice(0, limit)
        .map(copyRow),
    );
  }

  markReminder(workspaceId: string, firstFailedAt: Date, day: ReminderDay): Promise<boolean> {
    const row = this.rows.get(workspaceId);
    const bit = 1 << [0, 3, 6].indexOf(day);
    if (
      row?.state !== 'past_due' ||
      row.firstFailedAt?.getTime() !== firstFailedAt.getTime() ||
      (row.remindersSent & bit) !== 0
    ) {
      return Promise.resolve(false);
    }
    row.remindersSent |= bit;
    return Promise.resolve(true);
  }

  alignPastDueSince(workspaceId: string, at: Date) {
    const sub = this.subscriptions.get(workspaceId);
    if (sub?.status !== 'past_due') return Promise.resolve(null);
    if (sub.pastDueSince === null || sub.pastDueSince > at) sub.pastDueSince = at;
    return Promise.resolve({
      plan: sub.plan,
      status: sub.status,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      pastDueSince: sub.pastDueSince,
      seats: sub.seats,
    });
  }
}

/** A job the recording scheduler holds. */
export interface QueuedJob {
  id: string;
  name: 'remind' | 'wind-down';
  workspaceId: string;
  day?: ReminderDay;
  firstFailedAt?: Date;
  at: Date;
  done: boolean;
}

/** The `dunning` queue in memory (see the module comment). */
export function recordingScheduler() {
  const jobs = new Map<string, QueuedJob>();
  const cancelled: string[] = [];
  const scheduler: DunningScheduler = {
    remind(job) {
      const id = `remind-${job.workspaceId}-${job.firstFailedAt.getTime()}-${job.day}`;
      if (!jobs.has(id)) jobs.set(id, { id, name: 'remind', ...job, done: false });
      return Promise.resolve();
    },
    cancelReminders(workspaceId, firstFailedAt) {
      for (const day of [0, 3, 6]) {
        const id = `remind-${workspaceId}-${firstFailedAt.getTime()}-${day}`;
        if (jobs.get(id)?.done === false) {
          jobs.delete(id);
          cancelled.push(id);
        }
      }
      return Promise.resolve();
    },
    windDown(job) {
      const id = `wind-down-${job.workspaceId}-${job.noneAt.getTime()}`;
      if (!jobs.has(id)) {
        jobs.set(id, {
          id,
          name: 'wind-down',
          workspaceId: job.workspaceId,
          at: job.at,
          done: false,
        });
      }
      return Promise.resolve();
    },
  };
  return { scheduler, jobs, cancelled };
}

/** Everything a dunning test needs (see the module comment). */
export function dunningHarness() {
  const ent = serviceHarness();
  const clock = ent.clock;
  const contacts: Record<string, ReturnType<typeof contact>> = {};
  const billingRepo = memoryBilling(contacts);
  const stripe = { subs: new Map<string, StripeSub>() };
  const gateway = {
    retrieveSubscription: (id: string) => {
      const sub = stripe.subs.get(id);
      return sub === undefined
        ? Promise.reject(new StripeError('request', 'no such subscription', 404))
        : Promise.resolve({ ...sub });
    },
  };
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const billing = new BillingService({
    repository: billingRepo.repository,
    gateway: gateway as never,
    catalog: catalog(),
    entitlements: ent.service,
    clock: clock.read,
    logger: captured.logger,
  });
  const repository = new MemoryDunningRepository(billingRepo.subscriptions);
  const queue = recordingScheduler();
  const outbox = new MemoryOutbox();
  const events = new MemoryEventStore(clock.read);
  const notices: { channel: string; message: unknown }[] = [];
  const ended: string[] = [];
  const ender = { failures: [] as Error[] };
  const sent: { id: string; to: string; params: unknown; key: string | undefined }[] = [];
  const mailFailures: Error[] = [];
  const templates = new Set<string>();
  const mail = {
    templates: {
      ids: () => [...templates],
      registerTemplate: (id: string) => {
        templates.add(id);
      },
    },
    send: (id: string, to: string, params: unknown, opts?: { idempotencyKey?: string }) => {
      const failure = mailFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (!sent.some((s) => s.key === opts?.idempotencyKey)) {
        sent.push({ id, to, params, key: opts?.idempotencyKey });
      }
      return Promise.resolve({ queued: true as const, jobId: 'job' });
    },
  };
  const service = new DunningService({
    repository,
    entitlements: ent.service,
    billing: billingRepo.repository,
    outbox,
    notices: {
      publish: (channel, message) => {
        notices.push({ channel, message: JSON.parse(message) as unknown });
        return Promise.resolve();
      },
    },
    scheduler: queue.scheduler,
    sessions: {
      endLiveHostedSessions: (workspaceId) => {
        const failure = ender.failures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        ended.push(workspaceId);
        return Promise.resolve(2);
      },
    },
    config: { graceDays: 7, windDownMs: 10 * MIN },
    mail: mail as never,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const webhooks: WebhookEventInput[] = [];
  const notifications: NotificationEvent[] = [];
  const publish = () =>
    publishOutbox({
      outbox,
      emitWebhook: (input) => {
        webhooks.push(input);
        return Promise.resolve();
      },
      notify: {
        publish: (event) => {
          notifications.push(event);
          return Promise.resolve(newId('ntf'));
        },
      },
    });
  const processor = new EventProcessor({
    events,
    gateway,
    billing,
    outbox,
    workspaceOfCustomer: (id) => billingRepo.repository.workspaceOfCustomer(id),
    dunning: service,
    clock: clock.read,
    publish,
    logger: captured.logger,
  });

  /** Stores and processes a Stripe event created at `created` (default now); its id. */
  const deliver = async (
    type: string,
    object: Record<string, unknown>,
    created: Date = new Date(clock.now),
  ): Promise<string> => {
    const eventId = stripeId('evt');
    await events.insert({
      eventId,
      type,
      created: Math.floor(created.getTime() / 1000),
      object: reduceObject(object),
      status: 'received',
    });
    await processor.process(eventId, { finalAttempt: true });
    return eventId;
  };
  /** Processes stored event `eventId` again. */
  const replay = (eventId: string) => processor.replayEvent(eventId);

  /** A Team workspace with a billing contact, a customer and an active subscription. */
  const customer = async (): Promise<{ ws: string; sub: StripeSub }> => {
    const ws = ent.workspace();
    const customerId = stripeId('cus');
    billingRepo.customers.set(ws, customerId);
    contacts[ws] = contact(`billing-${ws.slice(-6).toLowerCase()}@example.test`);
    const sub = stripeSub(customerId, { plan: 'team' });
    stripe.subs.set(sub.id, sub);
    // Its last change was a month ago (B070 keeps only events newer than the stored one).
    await deliver('customer.subscription.updated', subObject(sub), new Date(clock.now - 30 * DAY));
    return { ws, sub };
  };
  /** Stripe moves subscription `sub` to `status` (and, optionally, a new period end). */
  const stripeMoves = (sub: StripeSub, status: string, periodEnd?: Date) => {
    const current = stripe.subs.get(sub.id) ?? sub;
    stripe.subs.set(sub.id, {
      ...current,
      status,
      ...(periodEnd === undefined ? {} : { periodEnd: Math.floor(periodEnd.getTime() / 1000) }),
    });
  };
  /** Runs the queued jobs due at the clock's time, as the worker would; their outcomes. */
  const runDue = async (): Promise<unknown[]> => {
    const out: unknown[] = [];
    const now = new Date(clock.now);
    for (const job of [...queue.jobs.values()].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (job.done || job.at > now) continue;
      job.done = true;
      if (job.name === 'remind' && job.day !== undefined && job.firstFailedAt !== undefined) {
        out.push(await service.remind(job.workspaceId, job.day, job.firstFailedAt, now));
      } else {
        out.push(await service.windDown(job.workspaceId));
      }
    }
    return out;
  };

  return {
    ent,
    clock,
    billing,
    billingRepo,
    stripe,
    repository,
    queue,
    outbox,
    events,
    notices,
    ended,
    ender,
    sent,
    mailFailures,
    service,
    webhooks,
    notifications,
    publish,
    processor,
    captured,
    recorded,
    deliver,
    replay,
    customer,
    stripeMoves,
    runDue,
  };
}

/** A raw Stripe subscription object of `sub` (what an event carries). */
export const subObject = (sub: StripeSub): Record<string, unknown> => ({
  object: 'subscription',
  id: sub.id,
  customer: sub.customerId,
  status: sub.status,
  currency: sub.currency.toLowerCase(),
});

/** A raw invoice object of `sub`, with id `invoiceId`. */
export const invoiceObject = (sub: StripeSub, invoiceId: string): Record<string, unknown> => ({
  object: 'invoice',
  id: invoiceId,
  customer: sub.customerId,
  subscription: sub.id,
  status: 'open',
  currency: 'eur',
  amount_due: 4900,
  amount_paid: 0,
});
