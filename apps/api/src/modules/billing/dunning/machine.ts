/**
 * The dunning state machine (B078, CT-ENTITLEMENTS §4): pure functions from a workspace's dunning
 * row, its subscription as B070 stores it and a billing event (or the time) to what to write.
 *
 * Dunning follows the subscription's **current** status: B072 re-fetches the subscription from
 * Stripe before every event is applied, so B070's row is Stripe's present state whatever order
 * the events came in. An old `invoice.payment_failed` that arrives after the `invoice.paid`
 * that settled it therefore finds the subscription `active` and changes nothing.
 *
 * | Dunning state \ subscription | `active` / `trialing`   | `past_due`              | `canceled`                | `none` (or no subscription) |
 * | ---------------------------- | ----------------------- | ----------------------- | ------------------------- | --------------------------- |
 * | no row (taken as `active`)   | nothing                 | → `past_due`            | → `canceled` (no end: quiet `none`) | quiet `none`    |
 * | `active` / `trialing`        | → the new one, if other | → `past_due`            | → `canceled` (no end: none) | → `none`                  |
 * | `past_due`                   | → it (recovered)        | nothing (grace kept)    | → `canceled` (no end: none) | → `none`                  |
 * | `canceled`                   | → it (resubscribed)     | → `past_due`            | nothing (new end kept)    | → `none`                    |
 * | `none`                       | → it (recovered)        | nothing (still unpaid)  | nothing                   | nothing                     |
 *
 * - **A failure** opens a grace window that ends exactly 7 days after `first_failed_at`: the time
 *   B070 recorded the subscription past due, or earlier when the event itself shows the failure
 *   (`invoice.payment_failed`, or a subscription event whose payload is `past_due` or `unpaid`) and
 *   was created before that, within FAILURE_WINDOW_MS (Stripe retries an undelivered webhook for
 *   up to 3 days). An event that does not show a failure (a seat change made while active, a
 *   payment) never moves the start earlier, so it cannot shorten the grace; a failure-showing
 *   event created up to 3 days earlier does, even one of an earlier failure that was settled in
 *   between (the window bounds that). A second failure while `past_due` moves nothing.
 * - **The end of grace** (`grace_until` passed) or of a canceled period (`period_end` passed)
 *   drops the workspace to `none`; so does a subscription that ended (`none`, or `canceled` with
 *   no period). Drops are stamped with the time dunning applied them (so the wind-down is always
 *   10 minutes after). `none` stays until the subscription is paid again. The first event of a
 *   workspace whose subscription is `active` writes an `active` row (no transition), so a
 *   workspace with no row has had no dunning event while paying: when its subscription ends this
 *   way it is recorded `none` quietly (already announced, no transition, no `plan_changed`).
 * - **The expiry job** re-checks the subscription: a row still `past_due` or `canceled` whose
 *   subscription is `active` or `trialing` again, or `canceled` with a period that ends later
 *   (the event that said so never reached dunning), follows it instead of dropping.
 * - **Reminders** go out on grace days 0, 3 and 6 (`first_failed_at` plus 0, 3 and 6 days), once
 *   each (a bit per day in `reminders_sent`), only while `past_due` in the same failure.
 *
 * Owns: these rules. Must not: read the clock, the database or Stripe.
 */
import { GRACE_MS } from '../../entitlements/resolve.js';

/** A workspace's status (CT-ENTITLEMENTS). */
export type Status = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

/** Why a workspace dropped to `none`. */
export type NoneReason = 'grace_expired' | 'period_ended' | 'subscription_ended';

/** The Stripe events dunning applies (B072 calls it for these, after reconciling). */
export const DUNNING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'invoice.payment_failed',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/** A billing event, as B072 hands it over. */
export interface BillingEvent {
  /** Stripe's `evt_…`. */
  id: string;
  type: string;
  /** When Stripe created the event. */
  created: Date;
  workspaceId: string;
  /** Stripe's `in_…`, for invoice events. */
  invoiceId: string | null;
  /** The status in the event's own payload (subscription events), as Stripe sent it. */
  objectStatus: string | null;
}

/** A status change (the card's `StatusTransition`). */
export interface StatusTransition {
  workspace: string;
  from: Status;
  to: Status;
  /** ISO time, while `past_due`. */
  grace_until: string | null;
}

/** A workspace's dunning row. */
export interface DunningRow {
  workspaceId: string;
  state: Status;
  failedInvoice: string | null;
  firstFailedAt: Date | null;
  graceUntil: Date | null;
  periodEnd: Date | null;
  /** Bits: 1 day 0, 2 day 3, 4 day 6. */
  remindersSent: number;
  noneAt: Date | null;
  noneReason: NoneReason | null;
  announcedAt: Date | null;
}

/** The subscription as B070 stores it (null: the workspace has none). */
export interface SubscriptionNow {
  status: Status;
  pastDueSince: Date | null;
  periodEnd: Date | null;
}

/** What applying an event comes to. */
export interface Decision {
  /** The row before (null: none yet). */
  previous: DunningRow | null;
  /** The row to write; null to write nothing. */
  next: DunningRow | null;
  /** The status change, if any. */
  transition: StatusTransition | null;
}

/** The row after `decision`: the one written, else the one before. */
export const current = (decision: Decision): DunningRow | null =>
  decision.next ?? decision.previous;

/** The grace-day reminders. */
export const REMINDER_DAYS = Object.freeze([0, 3, 6] as const);
/** A reminder day. */
export type ReminderDay = (typeof REMINDER_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** How much earlier than B070's record a failure event may place the failure (Stripe's retries). */
export const FAILURE_WINDOW_MS = 3 * DAY_MS;
const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/;

/** The bit of `day` in `reminders_sent`. */
export const reminderBit = (day: ReminderDay): number => 1 << REMINDER_DAYS.indexOf(day);

/** When the reminder of `day` is due, for a failure first seen at `firstFailedAt`. */
export const reminderDueAt = (firstFailedAt: Date, day: ReminderDay): Date =>
  new Date(firstFailedAt.getTime() + day * DAY_MS);

/** The reminder days of `row` due at `now` and not sent yet (none unless `past_due`). */
export function dueReminders(row: DunningRow | null, now: Date): ReminderDay[] {
  if (row?.state !== 'past_due' || row.firstFailedAt === null) return [];
  const failed = row.firstFailedAt;
  return REMINDER_DAYS.filter(
    (day) =>
      (row.remindersSent & reminderBit(day)) === 0 &&
      reminderDueAt(failed, day).getTime() <= now.getTime(),
  );
}

/** A row in `state` with the failure and drop fields cleared. */
function settled(workspaceId: string, state: Status, periodEnd: Date | null = null): DunningRow {
  return {
    workspaceId,
    state,
    failedInvoice: null,
    firstFailedAt: null,
    graceUntil: null,
    periodEnd,
    remindersSent: 0,
    noneAt: null,
    noneReason: null,
    announcedAt: null,
  };
}

/** A row dropped to `none` at `at` for `reason` (announced later). */
export function droppedRow(row: DunningRow, at: Date, reason: NoneReason): DunningRow {
  return {
    ...settled(row.workspaceId, 'none'),
    noneAt: at,
    noneReason: reason,
  };
}

const transitionOf = (from: Status, next: DunningRow): StatusTransition => ({
  workspace: next.workspaceId,
  from,
  to: next.state,
  grace_until: next.graceUntil?.toISOString() ?? null,
});

/** Whether `event` itself shows a failed payment (not just a subscription that is past due now). */
function showsFailure(event: BillingEvent): boolean {
  if (event.type === 'invoice.payment_failed') return true;
  return (
    event.type.startsWith('customer.subscription.') &&
    (event.objectStatus === 'past_due' || event.objectStatus === 'unpaid')
  );
}

/** When the failure began: see the module comment. */
function failureStart(sub: SubscriptionNow | null, event: BillingEvent, now: Date): Date {
  const recorded = sub?.pastDueSince ?? now;
  const created = event.created.getTime();
  return showsFailure(event) &&
    created < recorded.getTime() &&
    recorded.getTime() - created <= FAILURE_WINDOW_MS
    ? event.created
    : recorded;
}

/**
 * What applying `event` at `now` does to `row`, given the subscription as B070 now stores it
 * (`sub`, null for none). See the module comment.
 */
export function decide(
  row: DunningRow | null,
  sub: SubscriptionNow | null,
  event: BillingEvent,
  now: Date,
): Decision {
  const from: Status = row?.state ?? 'active';
  const target: Status = sub?.status ?? 'none';
  const ws = event.workspaceId;
  const invoice =
    event.type === 'invoice.payment_failed' &&
    event.invoiceId !== null &&
    INVOICE_ID.test(event.invoiceId)
      ? event.invoiceId
      : null;
  const move = (next: DunningRow): Decision => ({
    previous: row,
    next,
    transition: transitionOf(from, next),
  });
  const nothing: Decision = { previous: row, next: null, transition: null };
  /** The subscription ended at `at`: a drop, or a quiet `none` for a workspace with no row. */
  const endedAt = (at: Date): Decision =>
    row === null
      ? {
          previous: null,
          next: { ...droppedRow(settled(ws, 'none'), at, 'subscription_ended'), announcedAt: at },
          transition: null,
        }
      : move(droppedRow(row, at, 'subscription_ended'));

  switch (target) {
    case 'active':
    case 'trialing':
      if (row === null && target === 'active') {
        // A paying workspace's first event: record it, so a later ending is announced.
        return { previous: null, next: settled(ws, 'active'), transition: null };
      }
      return from === target ? nothing : move(settled(ws, target));
    case 'past_due': {
      if (from === 'none') return nothing;
      if (from === 'past_due') {
        // A later invoice event names the failure a status update opened: keep it, move nothing.
        if (row !== null && row.failedInvoice === null && invoice !== null) {
          return { previous: row, next: { ...row, failedInvoice: invoice }, transition: null };
        }
        return nothing;
      }
      const firstFailedAt = failureStart(sub, event, now);
      return move({
        ...settled(ws, 'past_due'),
        failedInvoice: invoice,
        firstFailedAt,
        graceUntil: new Date(firstFailedAt.getTime() + GRACE_MS),
      });
    }
    case 'canceled': {
      if (from === 'none') return nothing;
      const periodEnd = sub?.periodEnd ?? null;
      if (periodEnd === null) return endedAt(now);
      if (from === 'canceled') {
        // The same cancellation: keep it, with the end Stripe now reports.
        return row !== null && row.periodEnd?.getTime() !== periodEnd.getTime()
          ? { previous: row, next: { ...row, periodEnd }, transition: null }
          : nothing;
      }
      return move(settled(ws, 'canceled', periodEnd));
    }
    case 'none':
      return from === 'none' ? nothing : endedAt(now);
  }
}

/**
 * Whether `row` is over at `now`: a grace window or a canceled period that has ended (strictly
 * after its end, as B069's resolver keeps the plan up to and including it), with the reason;
 * null otherwise.
 */
export function expiry(row: DunningRow, now: Date): NoneReason | null {
  const at = now.getTime();
  if (row.state === 'past_due' && row.graceUntil !== null && row.graceUntil.getTime() < at) {
    return 'grace_expired';
  }
  if (row.state === 'canceled' && row.periodEnd !== null && row.periodEnd.getTime() < at) {
    return 'period_ended';
  }
  return null;
}

/**
 * The expiry job's decision for `row` at `now`, given the subscription now (`sub`): back to
 * `active` or `trialing` when the subscription is again, else the drop to `none` when the grace or
 * period is over, else nothing.
 */
export function decideExpiry(
  row: DunningRow | null,
  sub: SubscriptionNow | null,
  now: Date,
): Decision {
  const nothing: Decision = { previous: row, next: null, transition: null };
  if (row === null || (row.state !== 'past_due' && row.state !== 'canceled')) return nothing;
  if (sub !== null && (sub.status === 'active' || sub.status === 'trialing')) {
    const next = settled(row.workspaceId, sub.status);
    return { previous: row, next, transition: transitionOf(row.state, next) };
  }
  const end = sub?.status === 'canceled' ? sub.periodEnd : null;
  if (end !== null && end.getTime() >= now.getTime()) {
    if (row.state === 'canceled') {
      return row.periodEnd?.getTime() === end.getTime()
        ? nothing
        : { previous: row, next: { ...row, periodEnd: end }, transition: null };
    }
    const next = settled(row.workspaceId, 'canceled', end);
    return { previous: row, next, transition: transitionOf(row.state, next) };
  }
  const reason = expiry(row, now);
  if (reason === null) return nothing;
  const next = droppedRow(row, now, reason);
  return { previous: row, next, transition: transitionOf(row.state, next) };
}
