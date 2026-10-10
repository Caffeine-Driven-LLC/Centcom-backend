/**
 * Dunning (B078, CT-ENTITLEMENTS §4): the payment-failure lifecycle `active → past_due → (active
 * | none)` and `canceled → none at period end`.
 *
 * - **`applyBillingEvent(ev, now)`**: B072 calls it for `invoice.payment_failed`, `invoice.paid`,
 *   `customer.subscription.updated` and `customer.subscription.deleted`, after reconciling the
 *   subscription. The state machine (machine.ts) runs under the workspace's lock and the status
 *   change is audited (`billing.status`) in the same transaction. Then, whether or not this call
 *   changed anything (so a retried event finishes what a failed one started):
 *   - `past_due`: B070's `past_due_since` moves back to the failure's start (machine.ts) if it
 *     was later, and entitlements are re-applied (every time: B069 moves `rev` only when the
 *     resolved plan, status or limits change), so B069's `grace_until` is exactly 7 days after
 *     the failure; the reminders due now are queued;
 *   - left `past_due`: that failure's queued reminders are cancelled;
 *   - `none` not announced yet: announced (below).
 *   Entitlements themselves change through B070 and B069, which already moved `rev` for the
 *   status Stripe reported; dunning never writes a status of its own into them.
 * - **`expire(now)`** (the `dunning.expire` job, every 5 minutes): drops to `none` every workspace
 *   whose grace or canceled period has ended (or moves it back to `active`/`trialing` when its
 *   subscription is again), announces every drop not announced yet, and queues every reminder
 *   that is due and not sent: in batches of DUNNING_BATCH, oldest first, until a batch comes back
 *   short (at most DUNNING_MAX_BATCHES batches a run; the reminder scan pages on by failure time,
 *   as queuing a reminder does not change its row).
 * - **Announcing a drop:** reads the workspace's entitlements (B069 resolves the drop and moves
 *   `rev` on, under its lock, in the transaction that writes the status); when they say `none`,
 *   adds a `billing.subscription.updated` webhook to B072's outbox and queues one `wind-down` job
 *   10 minutes later (both once per drop: the outbox key and the job id), then claims the drop
 *   (marks it announced, if no one did) and only then publishes `sys.notice plan_changed {plan:
 *   'free'}` on `relay:notice:{wsp}`, so the notice goes out at most once. Entitlements that do
 *   not say `none` yet leave it for the next run.
 * - **`remind(ws, day, firstFailedAt, now)`**: on grace day 3 and 6, a `billing_issue {kind:
 *   payment_failed}` notification to owners and billing members through B072's outbox (day 0's
 *   is the one B072 already requests per failed invoice); on days 0, 3 and 6 the
 *   `billing_payment_failed` email to the billing contact (B032). Only while the same failure is
 *   still `past_due`, once per day (the day's bit; the outbox key and the email's idempotency key
 *   make a retried job send nothing twice). Either send failing does not stop the other; the job
 *   is retried for the one that failed.
 * - **`windDown(ws)`**: re-checks that the workspace is still `none` (dunning and entitlements)
 *   and ends its live hosted sessions through the SessionEnder port; otherwise does nothing.
 *
 * Nothing is deleted on any transition (CT-ENTITLEMENTS §7); LAN and local use are never touched.
 *
 * Owns: these rules. Must not: change entitlements other than through B070/B069, put card data,
 * amounts or Stripe ids in a notification or email, or log anything but ids, states and counts.
 */
import {
  noopMetrics,
  type EmailService,
  type Logger,
  type Metrics,
  type PubSub,
} from '@centcom/core';
import type { EntitlementService } from '../../entitlements/service.js';
import { INCLUDED_SEATS } from '../stripe/price-catalog.js';
import type { BillingRepository } from '../subscriptions/repository.js';
import type { OutboxStore } from '../webhooks/outbox.js';
import { statusAuditEvent } from './actions.js';
import type { DunningConfig } from './config.js';
import {
  current,
  decide,
  decideExpiry,
  DUNNING_EVENT_TYPES,
  dueReminders,
  reminderBit,
  reminderDueAt,
  type BillingEvent,
  type Decision,
  type DunningRow,
  type ReminderDay,
  type StatusTransition,
} from './machine.js';
import { PAYMENT_FAILED_TEMPLATE, PAYMENT_FAILED_TEMPLATE_ID } from './mail.js';
import { publishPlanChanged } from './notice.js';
import type { AlignedSubscription, DunningRepository } from './repository.js';

/** Rows one expiry batch handles (card B078: batches of 200, oldest first). */
export const DUNNING_BATCH = 200;
/** Batches one expiry run handles at most (the next run, 5 minutes later, goes on). */
export const DUNNING_MAX_BATCHES = 25;

/** The port that ends a workspace's live hosted sessions (wired to B053's lifecycle service). */
export interface SessionEnder {
  endLiveHostedSessions(workspaceId: string, reason: 'plan_changed'): Promise<number>;
}

/** Where dunning's jobs are queued (the worker's `dunning` queue). */
export interface DunningScheduler {
  /** Queues the reminder of `day` for the failure first seen at `firstFailedAt`, to run at `at`. */
  remind(job: {
    workspaceId: string;
    day: ReminderDay;
    firstFailedAt: Date;
    at: Date;
  }): Promise<void>;
  /** Removes that failure's queued reminders. */
  cancelReminders(workspaceId: string, firstFailedAt: Date): Promise<void>;
  /** Queues the wind-down of the drop at `noneAt`, to run at `at`. */
  windDown(job: { workspaceId: string; noneAt: Date; at: Date }): Promise<void>;
}

/** What dunning needs. */
export interface DunningServiceDeps {
  repository: DunningRepository;
  /** B069: `get` resolves (and moves `rev` on a drop), `applySubscriptionState` re-applies. */
  entitlements: Pick<EntitlementService, 'get' | 'applySubscriptionState'>;
  /** B070: whom to email. */
  billing: Pick<BillingRepository, 'billingContact'>;
  /** B072's outbox: notifications and webhooks, published after the fact. */
  outbox: Pick<OutboxStore, 'add'>;
  /** B009's pub/sub, for `relay:notice:{wsp}`. */
  notices: Pick<PubSub, 'publish'>;
  scheduler: DunningScheduler;
  sessions: SessionEnder;
  config: DunningConfig;
  /** B032's email service; without it no reminder email is sent. */
  mail?: Pick<EmailService, 'send' | 'templates'> | null;
  logger?: Logger;
  metrics?: Metrics;
}

/** What one expiry run did. */
export interface ExpireReport {
  expired: number;
  announced: number;
  reminders: number;
}

const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

/** The state B069 takes for a subscription dunning re-applies. */
function stateOf(sub: AlignedSubscription) {
  return {
    plan: sub.plan,
    status: sub.status,
    period:
      sub.periodStart === null || sub.periodEnd === null
        ? null
        : { start: sub.periodStart, end: sub.periodEnd },
    past_due_since: sub.pastDueSince,
    addon_seats: Math.max(0, sub.seats - INCLUDED_SEATS[sub.plan]),
  };
}

/** The dunning service (see the module comment). */
export class DunningService {
  readonly #metrics: Metrics;

  constructor(private readonly deps: DunningServiceDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
    const mail = deps.mail;
    if (mail != null && !mail.templates.ids().includes(PAYMENT_FAILED_TEMPLATE_ID)) {
      mail.templates.registerTemplate(PAYMENT_FAILED_TEMPLATE_ID, PAYMENT_FAILED_TEMPLATE);
    }
  }

  /** Applies a billing event (see the module comment); the status change, or null. */
  async applyBillingEvent(ev: BillingEvent, now: Date): Promise<StatusTransition | null> {
    if (!DUNNING_EVENT_TYPES.has(ev.type)) return null;
    const decision = await this.deps.repository.apply(
      ev.workspaceId,
      (row, sub) => decide(row, sub, ev, now),
      auditOf,
    );
    this.#record(decision, ev.type);
    await this.#follow(decision, now);
    return decision.transition;
  }

  /** The expiry job's run (see the module comment). */
  async expire(now: Date): Promise<ExpireReport> {
    const report: ExpireReport = { expired: 0, announced: 0, reminders: 0 };
    const { repository } = this.deps;
    await this.#batches(async () => {
      const due = await repository.expiring(now, DUNNING_BATCH);
      for (const workspaceId of due) {
        const decision = await repository.apply(
          workspaceId,
          (row, sub) => decideExpiry(row, sub, now),
          auditOf,
        );
        this.#record(decision, 'expire');
        if (decision.transition !== null) report.expired += 1;
      }
      return due.length;
    });
    await this.#batches(async () => {
      const drops = await repository.unannounced(DUNNING_BATCH);
      let done = 0;
      for (const row of drops) if (await this.#announce(row, now)) done += 1;
      report.announced += done;
      // Drops left unannounced stay first in the scan: stop rather than read them again.
      return done < drops.length ? 0 : drops.length;
    });
    // Queuing a reminder does not change its row (the job marks it), so this scan pages on.
    let after: DunningRow | null = null;
    await this.#batches(async () => {
      const rows = await repository.remindersDue(now, DUNNING_BATCH, after);
      for (const row of rows) report.reminders += await this.#queueReminders(row, now);
      after = rows.at(-1) ?? after;
      return rows.length;
    });
    if (report.expired + report.announced + report.reminders > 0) {
      this.deps.logger?.info({ ...report }, 'dunning.expired');
    }
    return report;
  }

  /** Sends the reminder of `day` (see the module comment); what it came to. */
  async remind(
    workspaceId: string,
    day: ReminderDay,
    firstFailedAt: Date,
    now: Date,
  ): Promise<'sent' | 'stale' | 'sent_before' | 'not_due'> {
    const outcome = await this.#remind(workspaceId, day, firstFailedAt, now);
    this.#metrics.counter('dunning_reminders_total', { day: String(day), outcome }).inc();
    return outcome;
  }

  /** Ends the live hosted sessions of a workspace still `none`; how many ended (0 if skipped). */
  async windDown(workspaceId: string): Promise<number> {
    const row = await this.deps.repository.find(workspaceId);
    const ent = row?.state === 'none' ? await this.deps.entitlements.get(workspaceId) : null;
    if (ent?.status !== 'none') {
      this.#metrics.counter('dunning_wind_downs_total', { outcome: 'skipped' }).inc();
      this.deps.logger?.info({ workspace_id: workspaceId }, 'dunning.wind_down_skipped');
      return 0;
    }
    const ended = await this.deps.sessions.endLiveHostedSessions(workspaceId, 'plan_changed');
    this.#metrics.counter('dunning_wind_downs_total', { outcome: 'ended' }).inc();
    this.deps.logger?.info({ workspace_id: workspaceId, sessions: ended }, 'dunning.wound_down');
    return ended;
  }

  /** Runs `batch` until it handles fewer than DUNNING_BATCH rows (at most the cap). */
  async #batches(batch: () => Promise<number>): Promise<void> {
    for (let i = 0; i < DUNNING_MAX_BATCHES; i += 1) {
      if ((await batch()) < DUNNING_BATCH) return;
    }
    this.deps.logger?.warn({ batches: DUNNING_MAX_BATCHES }, 'dunning.batches_capped');
  }

  #record(decision: Decision, cause: string): void {
    const t = decision.transition;
    if (t === null) return;
    this.#metrics.counter('dunning_transitions_total', { from: t.from, to: t.to }).inc();
    this.deps.logger?.info(
      { workspace_id: t.workspace, from: t.from, to: t.to, cause },
      'dunning.transition',
    );
  }

  /** What follows a decision, whether or not it changed anything (see the module comment). */
  async #follow(decision: Decision, now: Date): Promise<void> {
    const { previous } = decision;
    const row = current(decision);
    if (row === null) return;
    const ws = row.workspaceId;
    if (
      previous?.state === 'past_due' &&
      previous.firstFailedAt !== null &&
      (row.state !== 'past_due' ||
        row.firstFailedAt?.getTime() !== previous.firstFailedAt.getTime())
    ) {
      await this.deps.scheduler.cancelReminders(ws, previous.firstFailedAt);
    }
    if (row.state === 'past_due' && row.firstFailedAt !== null) {
      // Every time, not only when the date moved: a retry must finish a re-apply that failed.
      const aligned = await this.deps.repository.alignPastDueSince(ws, row.firstFailedAt);
      if (aligned !== null) {
        await this.deps.entitlements.applySubscriptionState(ws, stateOf(aligned));
      }
      await this.#queueReminders(row, now);
    }
    if (row.state === 'none' && row.announcedAt === null) await this.#announce(row, now);
  }

  /** Queues `row`'s due, unsent reminders; how many. */
  async #queueReminders(row: DunningRow, now: Date): Promise<number> {
    const failed = row.firstFailedAt;
    if (failed === null) return 0;
    const days = dueReminders(row, now);
    for (const day of days) {
      await this.deps.scheduler.remind({
        workspaceId: row.workspaceId,
        day,
        firstFailedAt: failed,
        at: reminderDueAt(failed, day),
      });
    }
    return days.length;
  }

  /** Announces the drop of `row` (see the module comment); false when left for the next run. */
  async #announce(row: DunningRow, now: Date): Promise<boolean> {
    const ws = row.workspaceId;
    const noneAt = row.noneAt;
    if (noneAt === null) return false;
    const ent = await this.deps.entitlements.get(ws);
    if (ent !== null && ent.status !== 'none') {
      this.deps.logger?.warn({ workspace_id: ws, status: ent.status }, 'dunning.announce_deferred');
      return false;
    }
    if (ent !== null) {
      // Idempotent first (the outbox key and the job id are per drop), then the claim, then the
      // notice: whoever claims the drop sends it, once (at most once, like the channel itself).
      await this.deps.outbox.add({
        type: 'billing.subscription.updated',
        workspaceId: ws,
        payload: { plan: ent.plan, status: 'none', seats: ent.limits.max_seats ?? 0 },
        dedupeKey: `dunning-none-${ws}-${noneAt.getTime()}`,
      });
      await this.deps.scheduler.windDown({
        workspaceId: ws,
        noneAt,
        at: new Date(Math.max(noneAt.getTime(), now.getTime()) + this.deps.config.windDownMs),
      });
    }
    if (!(await this.deps.repository.markAnnounced(ws, noneAt, now))) return false;
    if (ent !== null) await publishPlanChanged(this.deps.notices, ws);
    this.deps.logger?.info({ workspace_id: ws, rev: ent?.rev ?? null }, 'dunning.announced');
    return true;
  }

  async #remind(
    workspaceId: string,
    day: ReminderDay,
    firstFailedAt: Date,
    now: Date,
  ): Promise<'sent' | 'stale' | 'sent_before' | 'not_due'> {
    const row = await this.deps.repository.find(workspaceId);
    if (row?.state !== 'past_due' || row.firstFailedAt?.getTime() !== firstFailedAt.getTime()) {
      return 'stale';
    }
    if ((row.remindersSent & reminderBit(day)) !== 0) return 'sent_before';
    if (reminderDueAt(firstFailedAt, day).getTime() > now.getTime()) return 'not_due';
    const key = `dunning-${workspaceId}-${firstFailedAt.getTime()}-day${day}`;
    const failures: unknown[] = [];
    if (day !== 0) {
      // Day 0's notification is B072's, requested once per failed invoice.
      await this.deps.outbox
        .add({
          type: 'notify.billing_issue',
          workspaceId,
          payload: { kind: 'payment_failed' },
          dedupeKey: key,
        })
        .catch((err: unknown) => failures.push(err));
    }
    await this.#email(workspaceId, row, key).catch((err: unknown) => failures.push(err));
    if (failures.length > 0) {
      this.deps.logger?.warn(
        { workspace_id: workspaceId, day, error: errorKind(failures[0]) },
        'dunning.reminder_failed',
      );
      throw failures[0];
    }
    await this.deps.repository.markReminder(workspaceId, firstFailedAt, day);
    return 'sent';
  }

  async #email(workspaceId: string, row: DunningRow, key: string): Promise<void> {
    const mail = this.deps.mail;
    if (mail == null || row.graceUntil === null) return;
    const contact = await this.deps.billing.billingContact(workspaceId);
    if (contact === null) {
      this.deps.logger?.info({ workspace_id: workspaceId }, 'dunning.no_billing_contact');
      return;
    }
    await mail.send(
      PAYMENT_FAILED_TEMPLATE_ID,
      contact.email,
      { workspaceName: contact.name, graceUntil: row.graceUntil },
      { idempotencyKey: key },
    );
  }
}

/** The audit event of a decision's status change, or null. */
function auditOf(decision: Decision) {
  return decision.transition === null
    ? null
    : statusAuditEvent(decision.transition, decision.next?.noneReason ?? null);
}
