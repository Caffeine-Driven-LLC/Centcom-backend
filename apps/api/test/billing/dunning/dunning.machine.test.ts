/**
 * The dunning state machine (B078 test plan "unit: transition table for every (state, event)
 * pair, driven by a fake clock"):
 *
 * - every (dunning state, subscription status now) pair, for each of the four event types: the
 *   state reached, whether a row is written, and the transition reported;
 * - a failure's grace: `grace_until` exactly 7 days after B070's `past_due_since`, or after the
 *   event's time when the event itself shows the failure and is at most 3 days older; an old event
 *   that does not show it (a seat change, a payment, a failure older than 3 days) never moves the
 *   start earlier; a second failure keeps it; a later invoice event names the failure;
 * - a canceled period's end kept and updated; a canceled subscription without a period ends at
 *   once; a workspace with no row whose subscription ends is recorded `none` quietly; drops are
 *   stamped with the time they are applied;
 * - expiry strictly after the grace or period end (B069 keeps the plan up to and including it),
 *   or back to `active`/`trialing` when the subscription recovered without dunning hearing of it;
 * - reminder days 0, 3 and 6 due from the first failure, once each, only while `past_due`.
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  decideExpiry,
  DUNNING_EVENT_TYPES,
  dueReminders,
  reminderBit,
  type BillingEvent,
  type DunningRow,
  type Status,
  type SubscriptionNow,
} from '../../../src/modules/billing/dunning/index.js';
import { DAY, MIN, newId } from './helpers.js';

const T0 = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
const ws = newId('wsp');
const at = (ms: number) => new Date(T0.getTime() + ms);

const event = (
  type: string,
  created = T0,
  invoiceId: string | null = 'in_A1',
  objectStatus: string | null = null,
): BillingEvent => ({ id: 'evt_1', type, created, workspaceId: ws, invoiceId, objectStatus });
/** When dunning applies the events (an hour after T0). */
const NOW = new Date(T0.getTime() + 60 * MIN);

function row(state: Status, over: Partial<DunningRow> = {}): DunningRow {
  return {
    workspaceId: ws,
    state,
    failedInvoice: null,
    firstFailedAt: state === 'past_due' ? at(-DAY) : null,
    graceUntil: state === 'past_due' ? at(6 * DAY) : null,
    periodEnd: state === 'canceled' ? at(3 * DAY) : null,
    remindersSent: 0,
    noneAt: state === 'none' ? at(-DAY) : null,
    noneReason: state === 'none' ? 'grace_expired' : null,
    announcedAt: state === 'none' ? at(-DAY) : null,
    ...over,
  };
}

const sub = (status: Status, over: Partial<SubscriptionNow> = {}): SubscriptionNow => ({
  status,
  pastDueSince: status === 'past_due' ? T0 : null,
  periodEnd: at(30 * DAY),
  ...over,
});

type Target = Status | 'canceled_no_end' | 'gone';
const subOf = (t: Target): SubscriptionNow | null =>
  t === 'gone' ? null : t === 'canceled_no_end' ? sub('canceled', { periodEnd: null }) : sub(t);

/** The state reached for (dunning state, subscription now); '·' when nothing changes. */
/** 'quiet': a `none` row written already announced, with no transition. */
const TABLE: Record<string, Record<Target, Status | '·' | 'quiet'>> = {
  'no row': {
    active: '·',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'canceled',
    canceled_no_end: 'quiet',
    none: 'quiet',
    gone: 'quiet',
  },
  active: {
    active: '·',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'canceled',
    canceled_no_end: 'none',
    none: 'none',
    gone: 'none',
  },
  trialing: {
    active: 'active',
    trialing: '·',
    past_due: 'past_due',
    canceled: 'canceled',
    canceled_no_end: 'none',
    none: 'none',
    gone: 'none',
  },
  past_due: {
    active: 'active',
    trialing: 'trialing',
    past_due: '·',
    canceled: 'canceled',
    canceled_no_end: 'none',
    none: 'none',
    gone: 'none',
  },
  canceled: {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: '·',
    canceled_no_end: 'none',
    none: 'none',
    gone: 'none',
  },
  none: {
    active: 'active',
    trialing: 'trialing',
    past_due: '·',
    canceled: '·',
    canceled_no_end: '·',
    none: '·',
    gone: '·',
  },
};

describe('the transition table', () => {
  for (const type of DUNNING_EVENT_TYPES) {
    for (const [stateName, targets] of Object.entries(TABLE)) {
      for (const [target, expected] of Object.entries(targets) as [
        Target,
        Status | '·' | 'quiet',
      ][]) {
        it(`${type}: ${stateName} with the subscription ${target} → ${expected}`, () => {
          const before = stateName === 'no row' ? null : row(stateName as Status);
          const d = decide(before, subOf(target), event(type), NOW);
          if (expected === 'quiet') {
            expect(d.transition).toBeNull();
            expect(d.next).toMatchObject({
              state: 'none',
              noneAt: NOW,
              noneReason: 'subscription_ended',
              announcedAt: NOW,
            });
            return;
          }
          if (expected === '·') {
            expect(d.transition).toBeNull();
            expect(d.next?.state ?? before?.state ?? 'active').toBe(before?.state ?? 'active');
            return;
          }
          expect(d.next?.state).toBe(expected);
          expect(d.transition).toEqual({
            workspace: ws,
            from: before?.state ?? 'active',
            to: expected,
            grace_until: expected === 'past_due' ? (d.next?.graceUntil?.toISOString() ?? '') : null,
          });
          expect(d.previous).toEqual(before);
          // A move clears what the state left behind.
          if (expected !== 'past_due') {
            expect(d.next).toMatchObject({
              firstFailedAt: null,
              graceUntil: null,
              remindersSent: 0,
            });
          }
          if (expected === 'none') {
            expect(d.next).toMatchObject({
              noneAt: NOW,
              noneReason: 'subscription_ended',
              announcedAt: null,
            });
          }
        });
      }
    }
  }
});

describe('a failure', () => {
  it('opens a grace of exactly 7 days from the failure the event shows, within 3 days', () => {
    // The failure happened 2 hours before B070 recorded the subscription past due.
    const failed = at(-2 * 60 * MIN);
    const d = decide(
      row('active'),
      sub('past_due', { pastDueSince: T0 }),
      event('invoice.payment_failed', failed),
      NOW,
    );
    expect(d.next).toMatchObject({
      state: 'past_due',
      failedInvoice: 'in_A1',
      firstFailedAt: failed,
      graceUntil: new Date(failed.getTime() + 7 * DAY),
    });
    expect(d.transition?.grace_until).toBe(new Date(failed.getTime() + 7 * DAY).toISOString());
    // A subscription event whose payload is past_due shows it too.
    const update = decide(
      null,
      sub('past_due', { pastDueSince: T0 }),
      event('customer.subscription.updated', failed, null, 'past_due'),
      NOW,
    );
    expect(update.next?.firstFailedAt).toEqual(failed);
    // B070 recorded it first (a status update before the invoice event): its time wins.
    const earlier = at(-3 * 60 * MIN);
    const e = decide(
      null,
      sub('past_due', { pastDueSince: earlier }),
      event('invoice.payment_failed', T0, null),
      NOW,
    );
    expect(e.next).toMatchObject({ firstFailedAt: earlier, failedInvoice: null });
  });

  it('never moves the start earlier for an old event that does not show the failure', () => {
    const old = at(-30 * 60 * MIN);
    for (const ev of [
      event('customer.subscription.updated', old, null, 'active'),
      event('customer.subscription.updated', old, null, null),
      event('customer.subscription.deleted', old, null, 'active'),
      event('invoice.paid', old, 'in_OLD'),
      // A failure event older than Stripe's 3 days of webhook retries is another failure.
      event('invoice.payment_failed', at(-3 * DAY - 1)),
    ]) {
      const d = decide(row('active'), sub('past_due', { pastDueSince: T0 }), ev, NOW);
      expect(d.next, ev.type).toMatchObject({
        state: 'past_due',
        firstFailedAt: T0,
        graceUntil: at(7 * DAY),
      });
    }
    // Exactly 3 days earlier still counts.
    expect(
      decide(
        row('active'),
        sub('past_due', { pastDueSince: T0 }),
        event('invoice.payment_failed', at(-3 * DAY)),
        NOW,
      ).next?.firstFailedAt,
    ).toEqual(at(-3 * DAY));
    // No record at all: the time dunning applies it.
    expect(
      decide(row('active'), sub('past_due', { pastDueSince: null }), event('invoice.paid'), NOW)
        .next?.firstFailedAt,
    ).toEqual(NOW);
  });

  it('keeps its grace on a second failure, and takes the invoice a later event names', () => {
    const open = row('past_due', { failedInvoice: null });
    const second = decide(
      open,
      sub('past_due'),
      event('invoice.payment_failed', at(DAY), 'in_B2'),
      NOW,
    );
    expect(second.transition).toBeNull();
    expect(second.next).toEqual({ ...open, failedInvoice: 'in_B2' });
    const named = row('past_due', { failedInvoice: 'in_A1' });
    expect(
      decide(named, sub('past_due'), event('invoice.payment_failed', at(DAY), 'in_C3'), NOW),
    ).toEqual({
      previous: named,
      next: null,
      transition: null,
    });
    // An id that is not an invoice's is not kept.
    expect(
      decide(null, sub('past_due'), event('invoice.payment_failed', T0, 'evt_X'), NOW).next
        ?.failedInvoice,
    ).toBeNull();
  });
});

describe('a cancellation', () => {
  it('keeps the period end Stripe reports, and ends at once without one', () => {
    const canceled = row('canceled');
    const later = at(5 * DAY);
    expect(
      decide(
        canceled,
        sub('canceled', { periodEnd: later }),
        event('customer.subscription.updated'),
        NOW,
      ),
    ).toEqual({
      previous: canceled,
      next: { ...canceled, periodEnd: later },
      transition: null,
    });
    expect(
      decide(
        row('active'),
        sub('canceled', { periodEnd: later }),
        event('customer.subscription.deleted'),
        NOW,
      ).next,
    ).toMatchObject({ state: 'canceled', periodEnd: later });
    // A drop is stamped with the time it is applied, not the event's (the wind-down counts from it).
    expect(
      decide(
        row('active'),
        sub('canceled', { periodEnd: null }),
        event('customer.subscription.deleted', at(-DAY)),
        NOW,
      ).next,
    ).toMatchObject({ state: 'none', noneAt: NOW });
  });
});

describe('expiry', () => {
  it('drops a past_due workspace strictly after its grace, and a canceled one after its period', () => {
    const open = row('past_due', { graceUntil: T0, firstFailedAt: at(-7 * DAY) });
    const unpaid = sub('past_due');
    expect(decideExpiry(open, unpaid, T0).next).toBeNull();
    const d = decideExpiry(open, unpaid, at(1));
    expect(d.next).toMatchObject({
      state: 'none',
      noneAt: at(1),
      noneReason: 'grace_expired',
      graceUntil: null,
    });
    expect(d.transition).toEqual({
      workspace: ws,
      from: 'past_due',
      to: 'none',
      grace_until: null,
    });
    const canceled = row('canceled', { periodEnd: T0 });
    const ended = sub('canceled', { periodEnd: T0 });
    expect(decideExpiry(canceled, ended, T0).next).toBeNull();
    expect(decideExpiry(canceled, ended, at(1)).next).toMatchObject({
      state: 'none',
      noneReason: 'period_ended',
    });
    // Without a subscription any more, the end still drops it.
    expect(decideExpiry(open, null, at(1)).next).toMatchObject({ state: 'none' });
    for (const state of ['active', 'trialing', 'none'] as const) {
      expect(decideExpiry(row(state), sub('past_due'), at(400 * DAY)).next).toBeNull();
    }
    expect(decideExpiry(null, unpaid, T0).next).toBeNull();
  });

  it('moves back to the status of a subscription that recovered without dunning hearing of it', () => {
    const open = row('past_due', { graceUntil: T0, firstFailedAt: at(-7 * DAY) });
    for (const status of ['active', 'trialing'] as const) {
      const d = decideExpiry(open, sub(status), at(1));
      expect(d.next).toMatchObject({ state: status, graceUntil: null, noneAt: null });
      expect(d.transition).toMatchObject({ from: 'past_due', to: status });
    }
    expect(decideExpiry(row('canceled'), sub('active'), at(400 * DAY)).next?.state).toBe('active');
    // Canceled with a period that ends later: follow it, do not drop.
    const later = at(20 * DAY);
    const c = decideExpiry(open, sub('canceled', { periodEnd: later }), at(1));
    expect(c.next).toMatchObject({ state: 'canceled', periodEnd: later });
    expect(c.transition).toMatchObject({ from: 'past_due', to: 'canceled' });
    const ending = row('canceled', { periodEnd: T0 });
    expect(decideExpiry(ending, sub('canceled', { periodEnd: later }), at(1))).toMatchObject({
      next: { state: 'canceled', periodEnd: later },
      transition: null,
    });
  });
});

describe('reminders', () => {
  it('are due on grace days 0, 3 and 6, once each, only while past_due', () => {
    const open = row('past_due', { firstFailedAt: T0, graceUntil: at(7 * DAY) });
    expect(dueReminders(open, T0)).toEqual([0]);
    expect(dueReminders(open, at(3 * DAY - 1))).toEqual([0]);
    expect(dueReminders(open, at(3 * DAY))).toEqual([0, 3]);
    expect(dueReminders(open, at(6 * DAY))).toEqual([0, 3, 6]);
    const sent = { ...open, remindersSent: reminderBit(0) | reminderBit(3) };
    expect(dueReminders(sent, at(6 * DAY))).toEqual([6]);
    expect(dueReminders({ ...sent, remindersSent: 7 }, at(6 * DAY))).toEqual([]);
    for (const state of ['active', 'trialing', 'canceled', 'none'] as const) {
      expect(dueReminders(row(state), at(6 * DAY))).toEqual([]);
    }
    expect(dueReminders(null, T0)).toEqual([]);
  });
});
