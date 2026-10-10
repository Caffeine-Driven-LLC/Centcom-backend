/**
 * Dunning end to end, in memory (B078), through B072's event processor with real B070 and B069:
 *
 * - acceptance 1: a first `invoice.payment_failed` sets `past_due` and `grace_until` exactly 7
 *   days after the failure (the event's time, even when the webhook comes later: B070's
 *   `past_due_since` is moved back to it); a second failure does not move it;
 * - acceptance 2: during grace the entitlements are unchanged but `status: 'past_due'` and
 *   `grace_until`, and `rev` moved on once;
 * - acceptance 3: `invoice.paid` within grace returns to `active`, clears `grace_until`, cancels
 *   the queued reminders (and a reminder that runs anyway sends nothing), and moves `rev` on;
 * - acceptance 4: at `grace_until` + at most 5 min the workspace is `none`: `rev` moved on, one
 *   `plan_changed` notice, one `wind-down` job 10 min later that ends the live hosted sessions
 *   once; a second expiry run adds nothing (test plan: the wind-down does nothing if the
 *   workspace re-activated within the 10 minutes);
 * - acceptance 5: `canceled` keeps the plan until `period.end` and is `none` within 5 min after;
 * - acceptance 6: reminders on grace days 0, 3 and 6 only (3 emails, 3 notifications), never twice
 *   for a day, none after recovery (test plan: failure, day-3 reminder, payment, back to active);
 * - acceptance 7: the same Stripe event 5 times: one transition, one audit event, one webhook;
 * - acceptance 8: `invoice.paid` before an older `invoice.payment_failed` never leaves the
 *   workspace `past_due`;
 * - failure modes: the expiry run catches up in batches of 200, oldest first; an email failure
 *   does not stop the notification (and the retry sends no second one); an event for an unknown
 *   customer changes nothing; a drop the entitlements do not show yet waits for the next run;
 * - the wind-down skips a workspace no longer `none`, and a failing SessionEnder fails the job (for
 *   the worker's retries).
 */
import { describe, expect, it } from 'vitest';
import { webhookDataProblems } from '@centcom/core';
import { eventIssues } from '../../../src/modules/notifications/dispatcher/params.js';
import {
  DAY,
  dunningHarness,
  invoiceObject,
  MIN,
  stripeId,
  stripeSub,
  subObject,
} from './helpers.js';

const iso = (ms: number) => new Date(ms).toISOString();

/** A harness with a Team workspace whose subscription was last changed 30 days ago. */
async function withCustomer() {
  const h = dunningHarness();
  const { ws, sub } = await h.customer();
  return { h, ws, sub };
}

/** Stripe fails the renewal at `failedAt` and sends `invoice.payment_failed`. */
async function fail(
  h: ReturnType<typeof dunningHarness>,
  sub: Parameters<typeof subObject>[0],
  failedAt = new Date(h.clock.now),
) {
  h.stripeMoves(sub, 'past_due');
  const invoice = stripeId('in');
  const eventId = await h.deliver('invoice.payment_failed', invoiceObject(sub, invoice), failedAt);
  return { invoice, eventId };
}

describe('a failed payment (acceptance 1 and 2)', () => {
  it('opens a 7-day grace from the failure, once, with the entitlements otherwise unchanged', async () => {
    const { h, ws, sub } = await withCustomer();
    const before = await h.ent.service.get(ws);
    expect(before).toMatchObject({ plan: 'team', status: 'active', grace_until: null });

    // The failure happened 2 hours before the webhook was processed.
    const failedAt = h.clock.now - 2 * 60 * MIN;
    await fail(h, sub, new Date(failedAt));
    const graceUntil = iso(failedAt + 7 * DAY);
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'past_due',
      firstFailedAt: new Date(failedAt),
      graceUntil: new Date(failedAt + 7 * DAY),
    });
    expect(h.billingRepo.subscriptions.get(ws)?.pastDueSince).toEqual(new Date(failedAt));
    const during = await h.ent.service.get(ws);
    expect(during).toEqual({
      ...before,
      rev: (before?.rev ?? 0) + 1,
      status: 'past_due',
      grace_until: graceUntil,
    });

    // A second failure a day later moves nothing.
    h.clock.advance(DAY);
    await fail(h, sub);
    expect(h.repository.rows.get(ws)?.graceUntil).toEqual(new Date(failedAt + 7 * DAY));
    expect(await h.ent.service.get(ws)).toMatchObject({
      rev: during?.rev,
      grace_until: graceUntil,
    });
    expect(h.repository.audits.map((a) => a.meta)).toEqual([{ from: 'active', to: 'past_due' }]);
    expect(h.recorded.count('dunning_transitions_total', { from: 'active', to: 'past_due' })).toBe(
      1,
    );
  });
});

describe('a payment within grace (acceptance 3)', () => {
  it('returns to active, clears the grace, cancels the reminders and moves rev on', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    const failedAt = h.repository.rows.get(ws)?.firstFailedAt as Date;
    const during = await h.ent.service.get(ws);
    expect(h.queue.jobs.size).toBe(1); // day 0, not run yet

    h.clock.advance(2 * 60 * MIN);
    h.stripeMoves(sub, 'active');
    await h.deliver('invoice.paid', { ...invoiceObject(sub, stripeId('in')), amount_paid: 4900 });
    expect(h.repository.rows.get(ws)).toMatchObject({ state: 'active', graceUntil: null });
    expect(await h.ent.service.get(ws)).toMatchObject({
      status: 'active',
      grace_until: null,
      rev: (during?.rev ?? 0) + 1,
    });
    expect(h.queue.cancelled).toEqual([`remind-${ws}-${failedAt.getTime()}-0`]);
    // A reminder that runs anyway sends nothing; nor do later days.
    expect(await h.service.remind(ws, 3, failedAt, new Date(failedAt.getTime() + 3 * DAY))).toBe(
      'stale',
    );
    for (let day = 1; day <= 7; day += 1) {
      h.clock.now = failedAt.getTime() + day * DAY;
      await h.service.expire(new Date(h.clock.now));
      await h.runDue();
    }
    expect(h.sent).toEqual([]);
    expect(h.repository.audits.map((a) => a.meta)).toEqual([
      { from: 'active', to: 'past_due' },
      { from: 'past_due', to: 'active' },
    ]);
  });
});

describe('the end of grace (acceptance 4)', () => {
  it('drops to none within 5 min: rev moved on, one notice, one wind-down 10 min later', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    const graceUntil = (h.repository.rows.get(ws)?.graceUntil as Date).getTime();
    h.clock.now = graceUntil - MIN;
    expect(await h.service.expire(new Date(h.clock.now))).toMatchObject({ expired: 0 });
    const during = await h.ent.service.get(ws);
    expect(during?.status).toBe('past_due');

    // The next 5-minute run after the grace ended.
    h.clock.now = graceUntil + 4 * MIN;
    const now = h.clock.now;
    expect(await h.service.expire(new Date(now))).toMatchObject({ expired: 1, announced: 1 });
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'none',
      noneReason: 'grace_expired',
      noneAt: new Date(now),
      announcedAt: new Date(now),
    });
    const after = await h.ent.service.get(ws);
    expect(after).toMatchObject({ plan: 'free', status: 'none', rev: (during?.rev ?? 0) + 1 });
    expect(h.notices).toEqual([
      {
        channel: `relay:notice:${ws}`,
        message: { code: 'plan_changed', level: 'info', params: { plan: 'free' } },
      },
    ]);
    const windDowns = [...h.queue.jobs.values()].filter((j) => j.name === 'wind-down');
    expect(windDowns.map((j) => j.at.getTime())).toEqual([now + 10 * MIN]);
    expect(h.repository.audits.at(-1)?.meta).toEqual({
      from: 'past_due',
      to: 'none',
      reason: 'grace_expired',
    });

    // Another run adds nothing.
    h.clock.advance(5 * MIN);
    expect(await h.service.expire(new Date(h.clock.now))).toEqual({
      expired: 0,
      announced: 0,
      reminders: 0,
    });
    expect(h.notices).toHaveLength(1);
    expect([...h.queue.jobs.values()].filter((j) => j.name === 'wind-down')).toHaveLength(1);
    expect(await h.ent.service.get(ws)).toMatchObject({ rev: after?.rev });

    // 10 minutes after the drop: the live hosted sessions end, once.
    h.clock.now = now + 10 * MIN - 1;
    await h.runDue();
    expect(h.ended).toEqual([]);
    h.clock.now = now + 10 * MIN;
    expect(await h.runDue()).toEqual([2]);
    expect(await h.runDue()).toEqual([]);
    expect(h.ended).toEqual([ws]);
    expect(h.recorded.count('dunning_wind_downs_total', { outcome: 'ended' })).toBe(1);

    // The drop's webhook: billing.subscription.updated, CT-WEBHOOKS' shape.
    await h.publish();
    const dropped = h.webhooks.filter(
      (w) => w.type === 'billing.subscription.updated' && w.data['status'] === 'none',
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.data).toMatchObject({ plan: 'free', status: 'none' });
    expect(webhookDataProblems('billing.subscription.updated', dropped[0]?.data)).toEqual([]);
  });

  it('does nothing at wind-down when the workspace paid within the 10 minutes', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    h.clock.now = (h.repository.rows.get(ws)?.graceUntil as Date).getTime() + 2 * MIN;
    await h.service.expire(new Date(h.clock.now));
    expect(h.repository.rows.get(ws)?.state).toBe('none');

    h.clock.advance(3 * MIN);
    h.stripeMoves(sub, 'active');
    await h.deliver('invoice.paid', { ...invoiceObject(sub, stripeId('in')), amount_paid: 4900 });
    expect(h.repository.rows.get(ws)?.state).toBe('active');
    expect(await h.ent.service.get(ws)).toMatchObject({ plan: 'team', status: 'active' });

    h.clock.advance(10 * MIN);
    expect(await h.runDue()).toContain(0);
    expect(h.ended).toEqual([]);
    expect(h.recorded.count('dunning_wind_downs_total', { outcome: 'skipped' })).toBe(1);
  });

  it('fails the wind-down when the SessionEnder throws, so the worker retries it', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    h.clock.now = (h.repository.rows.get(ws)?.graceUntil as Date).getTime() + MIN;
    await h.service.expire(new Date(h.clock.now));
    h.ender.failures.push(new Error('relay down'));
    await expect(h.service.windDown(ws)).rejects.toThrow('relay down');
    expect(await h.service.windDown(ws)).toBe(2);
    expect(h.ended).toEqual([ws]);
  });
});

describe('a cancellation (acceptance 5)', () => {
  it('keeps the plan until period.end and drops to none within 5 min after it', async () => {
    const { h, ws, sub } = await withCustomer();
    const end = h.clock.now + 3 * DAY;
    h.stripeMoves(sub, 'canceled', new Date(end));
    await h.deliver('customer.subscription.deleted', { ...subObject(sub), status: 'canceled' });
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'canceled',
      periodEnd: new Date(end),
    });
    const canceled = await h.ent.service.get(ws);
    expect(canceled).toMatchObject({ plan: 'team', status: 'canceled' });

    h.clock.now = end;
    expect(await h.service.expire(new Date(h.clock.now))).toMatchObject({ expired: 0 });
    expect(await h.ent.service.get(ws)).toMatchObject({ plan: 'team', status: 'canceled' });

    h.clock.now = end + 4 * MIN;
    expect(await h.service.expire(new Date(h.clock.now))).toMatchObject({
      expired: 1,
      announced: 1,
    });
    expect(h.repository.rows.get(ws)).toMatchObject({ state: 'none', noneReason: 'period_ended' });
    expect(await h.ent.service.get(ws)).toMatchObject({
      plan: 'free',
      status: 'none',
      rev: (canceled?.rev ?? 0) + 1,
    });
    expect(h.notices).toHaveLength(1);
  });
});

describe('reminders (acceptance 6)', () => {
  it('go out on grace days 0, 3 and 6 only: 3 emails and 3 notifications, never twice', async () => {
    const { h, ws, sub } = await withCustomer();
    // Counted from before the failure: day 0's notification is B072's, published with it.
    let emails = h.sent.length;
    let notifications = h.notifications.length;
    const { invoice } = await fail(h, sub);
    const failedAt = h.repository.rows.get(ws)?.firstFailedAt as Date;
    const perDay: { day: number; emails: number; notifications: number }[] = [];
    for (let day = 0; day <= 6; day += 1) {
      // Every 5-minute run of the day, as far as reminders go: the first after the day starts.
      h.clock.now = failedAt.getTime() + day * DAY + MIN;
      await h.service.expire(new Date(h.clock.now));
      await h.runDue();
      await h.service.expire(new Date(h.clock.now + 5 * MIN));
      await h.runDue();
      await h.publish();
      perDay.push({
        day,
        emails: h.sent.length - emails,
        notifications: h.notifications.length - notifications,
      });
      emails = h.sent.length;
      notifications = h.notifications.length;
    }
    expect(perDay.filter((d) => d.emails > 0 || d.notifications > 0)).toEqual([
      { day: 0, emails: 1, notifications: 1 },
      { day: 3, emails: 1, notifications: 1 },
      { day: 6, emails: 1, notifications: 1 },
    ]);
    expect(h.notifications.map((n) => n.dedupeKey)).toEqual([
      `billing_issue:${invoice}`,
      `billing_issue:dunning-${ws}-${failedAt.getTime()}-day3`,
      `billing_issue:dunning-${ws}-${failedAt.getTime()}-day6`,
    ]);
    for (const n of h.notifications) {
      expect(n).toMatchObject({
        category: 'billing_issue',
        params: { kind: 'payment_failed' },
        recipients: { workspace: ws, roles: ['owner', 'billing'] },
      });
      expect(eventIssues(n)).toEqual([]);
    }
    expect(h.sent).toHaveLength(3);
    for (const mail of h.sent) {
      expect(mail).toMatchObject({
        id: 'billing_payment_failed',
        to: `billing-${ws.slice(-6).toLowerCase()}@example.test`,
        params: { workspaceName: 'Acme', graceUntil: new Date(failedAt.getTime() + 7 * DAY) },
      });
    }
    // A day's reminder run again sends nothing.
    expect(await h.service.remind(ws, 3, failedAt, new Date(h.clock.now))).toBe('sent_before');
    expect(h.recorded.count('dunning_reminders_total', { day: '6', outcome: 'sent' })).toBe(1);
    // Day 7: the grace is over, nothing more goes out.
    h.clock.now = failedAt.getTime() + 7 * DAY + MIN;
    await h.service.expire(new Date(h.clock.now));
    await h.runDue();
    await h.publish();
    expect(h.sent).toHaveLength(3);
    expect(h.notifications).toHaveLength(3);
  });

  it('keeps the notification when the email fails, and the retry sends no second one', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    const failedAt = h.repository.rows.get(ws)?.firstFailedAt as Date;
    await h.runDue(); // day 0
    h.mailFailures.push(new Error('EmailProviderError'));
    const day3 = new Date(failedAt.getTime() + 3 * DAY);
    await expect(h.service.remind(ws, 3, failedAt, day3)).rejects.toThrow('EmailProviderError');
    await h.publish();
    const day3Notifications = () =>
      h.notifications.filter((n) => n.dedupeKey?.endsWith('-day3') === true);
    expect(day3Notifications()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(await h.service.remind(ws, 3, failedAt, day3)).toBe('sent');
    await h.publish();
    expect(day3Notifications()).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });

  it('waits for a reminder that is not due yet', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    const failedAt = h.repository.rows.get(ws)?.firstFailedAt as Date;
    expect(await h.service.remind(ws, 6, failedAt, new Date(failedAt.getTime() + 5 * DAY))).toBe(
      'not_due',
    );
  });
});

describe('replays and order (acceptance 7 and 8)', () => {
  it('applies the same Stripe event 5 times as once: one transition, one audit event, one webhook event of each type', async () => {
    const { h, ws, sub } = await withCustomer();
    await h.publish();
    const webhooksBefore = h.webhooks.length;
    const { eventId } = await fail(h, sub);
    for (let i = 0; i < 4; i += 1) await h.replay(eventId);
    await h.publish();
    expect(h.repository.audits).toHaveLength(1);
    expect(h.recorded.count('dunning_transitions_total', { from: 'active', to: 'past_due' })).toBe(
      1,
    );
    // B072's two for the event (deduped by invoice and by event id): one of each, however often.
    expect(h.webhooks.slice(webhooksBefore).map((w) => w.type)).toEqual([
      'billing.subscription.updated',
      'billing.invoice.payment_failed',
    ]);
    expect(h.repository.rows.get(ws)?.state).toBe('past_due');
  });

  it('never leaves the workspace past_due when invoice.paid arrives before an older failure', async () => {
    const { h, ws, sub } = await withCustomer();
    const failedAt = new Date(h.clock.now - 60 * MIN);
    // Stripe already retried and collected: the subscription is active again.
    h.stripeMoves(sub, 'active');
    await h.deliver('invoice.paid', { ...invoiceObject(sub, stripeId('in')), amount_paid: 4900 });
    await h.deliver('invoice.payment_failed', invoiceObject(sub, stripeId('in')), failedAt);
    expect(h.repository.rows.get(ws)?.state ?? 'active').toBe('active');
    expect(await h.ent.service.get(ws)).toMatchObject({ status: 'active', grace_until: null });
    expect(h.repository.audits).toEqual([]);
  });
});

describe('delayed events', () => {
  it('never shortens the grace for an old event that does not show the failure', async () => {
    const { h, ws, sub } = await withCustomer();
    // The renewal fails now; an older seat change (created 30 hours ago, then active) is delivered
    // late and processed first.
    h.stripeMoves(sub, 'past_due');
    await h.deliver(
      'customer.subscription.updated',
      { ...subObject(sub), status: 'active' },
      new Date(h.clock.now - 30 * 60 * MIN),
    );
    const failedAt = h.clock.now;
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'past_due',
      firstFailedAt: new Date(failedAt),
      graceUntil: new Date(failedAt + 7 * DAY),
    });
    await h.deliver('invoice.payment_failed', invoiceObject(sub, stripeId('in')));
    expect(h.repository.rows.get(ws)?.graceUntil).toEqual(new Date(failedAt + 7 * DAY));
    expect(await h.ent.service.get(ws)).toMatchObject({
      status: 'past_due',
      grace_until: new Date(failedAt + 7 * DAY).toISOString(),
    });
  });

  it('starts the grace at a late past_due subscription update, as B072 hands its payload status over', async () => {
    const { h, ws, sub } = await withCustomer();
    const failedAt = h.clock.now;
    h.stripeMoves(sub, 'past_due');
    h.clock.advance(2 * 60 * MIN); // processed 2 hours after Stripe sent it
    await h.deliver(
      'customer.subscription.updated',
      { ...subObject(sub), status: 'past_due' },
      new Date(failedAt),
    );
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'past_due',
      firstFailedAt: new Date(failedAt),
      graceUntil: new Date(failedAt + 7 * DAY),
    });
    expect(await h.ent.service.get(ws)).toMatchObject({
      grace_until: new Date(failedAt + 7 * DAY).toISOString(),
    });
  });

  it('announces the end of a paying workspace that never failed before', async () => {
    const { h, ws, sub } = await withCustomer();
    await h.deliver('invoice.paid', { ...invoiceObject(sub, stripeId('in')), amount_paid: 4900 });
    expect(h.repository.rows.get(ws)).toMatchObject({ state: 'active' });
    h.stripe.subs.set(sub.id, { ...sub, status: 'incomplete_expired' });
    await h.deliver('customer.subscription.updated', {
      ...subObject(sub),
      status: 'incomplete_expired',
    });
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'none',
      announcedAt: new Date(h.clock.now),
    });
    expect(h.notices).toHaveLength(1);
    expect(h.repository.audits.map((a) => a.meta)).toEqual([
      { from: 'active', to: 'none', reason: 'subscription_ended' },
    ]);
  });

  it('winds down 10 minutes after a late subscription deletion is applied, not after its event', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    h.clock.advance(DAY);
    // Stripe deleted the subscription an hour ago, with no period left.
    h.stripe.subs.set(sub.id, { ...sub, status: 'canceled', periodStart: null, periodEnd: null });
    await h.deliver(
      'customer.subscription.deleted',
      { ...subObject(sub), status: 'canceled' },
      new Date(h.clock.now - 60 * MIN),
    );
    expect(h.repository.rows.get(ws)).toMatchObject({
      state: 'none',
      noneReason: 'subscription_ended',
      noneAt: new Date(h.clock.now),
    });
    expect(h.notices).toHaveLength(1);
    const windDowns = [...h.queue.jobs.values()].filter((j) => j.name === 'wind-down');
    expect(windDowns.map((j) => j.at.getTime())).toEqual([h.clock.now + 10 * MIN]);
  });
});

describe('failure modes', () => {
  it('catches up after hours down: every overdue workspace, in batches of 200, oldest first', async () => {
    const h = dunningHarness();
    const now = h.clock.now;
    const workspaces: string[] = [];
    for (let i = 0; i < 450; i += 1) {
      const ws = h.ent.workspace();
      workspaces.push(ws);
      // Grace ended between 1 and 450 minutes ago, newest first.
      const failedAt = new Date(now - 7 * DAY - (i + 1) * MIN);
      h.repository.rows.set(ws, {
        workspaceId: ws,
        state: 'past_due',
        failedInvoice: null,
        firstFailedAt: failedAt,
        graceUntil: new Date(failedAt.getTime() + 7 * DAY),
        periodEnd: null,
        remindersSent: 7,
        noneAt: null,
        noneReason: null,
        announcedAt: null,
      });
    }
    expect(await h.service.expire(new Date(now))).toEqual({
      expired: 450,
      announced: 450,
      reminders: 0,
    });
    // Dropped oldest grace first (the audit trail is in the order of the drops).
    expect(h.repository.audits.map((a) => a.workspaceId)).toEqual([...workspaces].reverse());
    expect(h.notices).toHaveLength(450);
    expect([...h.repository.rows.values()].every((r) => r.state === 'none')).toBe(true);
  });

  it('publishes the notice of a drop once when three runs announce it at the same time', async () => {
    const { h, ws, sub } = await withCustomer();
    await fail(h, sub);
    h.clock.now = (h.repository.rows.get(ws)?.graceUntil as Date).getTime() + MIN;
    const now = new Date(h.clock.now);
    await Promise.all([h.service.expire(now), h.service.expire(now), h.service.expire(now)]);
    expect(h.notices).toHaveLength(1);
    expect([...h.queue.jobs.values()].filter((j) => j.name === 'wind-down')).toHaveLength(1);
    expect(h.repository.audits.filter((a) => a.meta?.['to'] === 'none')).toHaveLength(1);
  });

  it('queues every due reminder once, however many are due (it pages past 200)', async () => {
    const h = dunningHarness();
    const now = h.clock.now;
    for (let i = 0; i < 450; i += 1) {
      const ws = h.ent.workspace();
      const failedAt = new Date(now - (i + 1) * MIN);
      h.repository.rows.set(ws, {
        workspaceId: ws,
        state: 'past_due',
        failedInvoice: null,
        firstFailedAt: failedAt,
        graceUntil: new Date(failedAt.getTime() + 7 * DAY),
        periodEnd: null,
        remindersSent: 0,
        noneAt: null,
        noneReason: null,
        announcedAt: null,
      });
    }
    expect(await h.service.expire(new Date(now))).toEqual({
      expired: 0,
      announced: 0,
      reminders: 450,
    });
    expect(h.queue.jobs.size).toBe(450);
    expect(h.captured.lines().some((l) => l['msg'] === 'dunning.batches_capped')).toBe(false);
  });

  it('leaves a drop the entitlements do not show yet for the next run', async () => {
    const { h, ws } = await withCustomer();
    h.repository.rows.set(ws, {
      workspaceId: ws,
      state: 'none',
      failedInvoice: null,
      firstFailedAt: null,
      graceUntil: null,
      periodEnd: null,
      remindersSent: 0,
      noneAt: new Date(h.clock.now),
      noneReason: 'subscription_ended',
      announcedAt: null,
    });
    expect(await h.service.expire(new Date(h.clock.now))).toMatchObject({ announced: 0 });
    expect(h.notices).toEqual([]);
    expect(h.repository.rows.get(ws)?.announcedAt).toBeNull();
    expect(h.captured.lines().some((l) => l['msg'] === 'dunning.announce_deferred')).toBe(true);
  });

  it('changes nothing for an event of an unknown customer', async () => {
    const { h } = await withCustomer();
    const stranger = stripeSub(stripeId('cus'), { status: 'past_due' });
    h.stripe.subs.set(stranger.id, stranger);
    const eventId = await h.deliver(
      'invoice.payment_failed',
      invoiceObject(stranger, stripeId('in')),
    );
    expect((await h.events.get(eventId))?.status).toBe('failed');
    expect([...h.repository.rows.values()].map((r) => r.state)).toEqual(['active']); // the customer's own
    expect(h.repository.audits).toEqual([]);
  });

  it('logs ids, states and counts only', async () => {
    const { h, sub } = await withCustomer();
    const { invoice } = await fail(h, sub);
    await h.runDue();
    const text = JSON.stringify(h.captured.lines());
    expect(text).not.toContain(invoice);
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain(sub.customerId);
  });
});
