/**
 * Trials through B072's Stripe event handlers (B079 scope "Handling of Stripe
 * customer.subscription.trial_will_end (3 days before) to send an email via B032 and a webhook
 * billing.subscription.updated event", guardrail "MUST NOT grant trial status without Stripe
 * confirming the trial subscription state"):
 *
 * - `customer.subscription.trial_will_end` re-fetches the subscription, stores it, writes one
 *   `billing.subscription.updated` outbox row for the event (B081's webhook) and one
 *   `notify.trial_ending` row (CT-NOTIF `trial_ending {days}`, inbox by default, through B063),
 *   and emails the billing contact through B032's `trial_ending` template, with an idempotency
 *   key per subscription and trial end, so a redelivered event or a retry sends one email;
 * - an email failure is thrown, so B072 retries the event;
 * - a subscription event whose subscription Stripe reports `trialing` records the trial; one that
 *   is not trialing records nothing; without B079's hooks, B072 still announces the event;
 * - the template renders the workspace's name and the trial's end, nothing else.
 */
import { renderTemplate, type EmailTemplate } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { TRIAL_ENDING_TEMPLATE } from '../../../src/modules/billing/promotions/trial-mail.js';
import { TrialService } from '../../../src/modules/billing/promotions/trials.js';
import { handleEvent, type HandlerDeps } from '../../../src/modules/billing/webhooks/handlers.js';
import type { OutboxEntry } from '../../../src/modules/billing/webhooks/outbox.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { catalog, contact, FakeStripe, memoryBilling } from '../subscriptions/helpers.js';
import { memoryPromotions, newId, stripeId, stripeSub } from './helpers.js';

const TRIAL_END = Date.UTC(2026, 9, 12, 12, 0, 0) / 1000;

function setup(withTrials = true) {
  const ws = newId('wsp');
  const owner = newId('usr');
  const customer = stripeId('cus');
  const billing = memoryBilling({ [ws]: contact('billing@example.test') });
  billing.customers.set(ws, customer);
  const sub = stripeSub(customer, { status: 'trialing', trialEnd: TRIAL_END });
  const gateway = {
    retrieveSubscription: (id: string) =>
      id === sub.id ? Promise.resolve(sub) : Promise.reject(new Error('no such subscription')),
  };
  const service = new BillingService({
    repository: billing.repository,
    gateway: new FakeStripe(),
    catalog: catalog(),
  });
  const outbox: OutboxEntry[] = [];
  const keys = new Set<string>();
  const mirror = memoryPromotions({ [ws]: [owner] });
  const sent: { id: string; to: string; params: unknown; key: string | undefined }[] = [];
  const failures: Error[] = [];
  const templates = new Set<string>();
  const mail = {
    templates: {
      ids: () => [...templates],
      registerTemplate: (id: string) => {
        templates.add(id);
      },
    },
    send: (id: string, to: string, params: unknown, opts?: { idempotencyKey?: string }) => {
      const failure = failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      if (!sent.some((s) => s.key === opts?.idempotencyKey)) {
        sent.push({ id, to, params, key: opts?.idempotencyKey });
      }
      return Promise.resolve({ queued: true as const, jobId: 'job' });
    },
  };
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const trials = new TrialService({
    repository: mirror.repository,
    billing: billing.repository,
    config: { trialDays: 14, trialPlan: 'team' },
    mail: mail as never,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const deps: HandlerDeps = {
    gateway,
    billing: service,
    outbox: {
      add: (entry) => {
        const key = `${entry.type}/${entry.dedupeKey}`;
        if (keys.has(key)) return Promise.resolve(false);
        keys.add(key);
        outbox.push(entry);
        return Promise.resolve(true);
      },
    },
    workspaceOfCustomer: (id) => billing.repository.workspaceOfCustomer(id),
    ...(withTrials ? { trials } : {}),
  };
  const event = (type: string, created: number, id = stripeId('evt')) => ({
    eventId: id,
    type,
    created,
    object: { object: 'subscription', id: sub.id, customer, status: 'trialing' },
  });
  return { ws, owner, sub, outbox, mirror, sent, failures, templates, deps, event, recorded };
}

describe('customer.subscription.trial_will_end', () => {
  it('announces the subscription and emails the billing contact once', async () => {
    const t = setup();
    const event = t.event('customer.subscription.trial_will_end', TRIAL_END - 3 * 86_400);
    expect(await handleEvent(event, t.deps)).toBe('processed');
    expect(t.outbox).toEqual([
      {
        type: 'billing.subscription.updated',
        workspaceId: t.ws,
        payload: { plan: 'team', status: 'trialing', seats: 5 },
        dedupeKey: event.eventId,
      },
      {
        type: 'notify.trial_ending',
        workspaceId: t.ws,
        payload: { days: 3 },
        dedupeKey: `${t.sub.id}-${TRIAL_END}`,
      },
    ]);
    expect(t.templates.has('trial_ending')).toBe(true);
    expect(t.sent).toEqual([
      {
        id: 'trial_ending',
        to: 'billing@example.test',
        params: { workspaceName: 'Acme', trialEnd: new Date(TRIAL_END * 1000) },
        key: `trial-ending-${t.sub.id}-${TRIAL_END}`,
      },
    ]);
    // Redelivered, or the same event replayed: no second email, no second row.
    expect(await handleEvent(event, t.deps)).toBe('processed');
    expect(t.sent).toHaveLength(1);
    expect(t.outbox).toHaveLength(2);
    // The trial is recorded (it was missed earlier), with the workspace's owners.
    expect(t.mirror.trials).toEqual([
      expect.objectContaining({
        stripeSubscriptionId: t.sub.id,
        workspaceId: t.ws,
        ownerUserIds: [t.owner],
      }),
    ]);
    expect(t.recorded.count('trial_ending_emails_total', { outcome: 'sent' })).toBe(2);
  });

  it('throws an email failure, so B072 retries the event', async () => {
    const t = setup();
    t.failures.push(new Error('email queue down'));
    const event = t.event('customer.subscription.trial_will_end', TRIAL_END - 3 * 86_400);
    await expect(handleEvent(event, t.deps)).rejects.toThrow('email queue down');
    expect(await handleEvent(event, t.deps)).toBe('processed');
    expect(t.sent).toHaveLength(1);
  });

  it('still announces the event without B079 hooks, and ignores a malformed one', async () => {
    const t = setup(false);
    const event = t.event('customer.subscription.trial_will_end', TRIAL_END - 3 * 86_400);
    expect(await handleEvent(event, t.deps)).toBe('processed');
    expect(t.outbox.map((e) => e.type)).toEqual([
      'billing.subscription.updated',
      'notify.trial_ending',
    ]);
    expect(t.sent).toHaveLength(0);
    expect(
      await handleEvent({ ...event, object: { object: 'subscription', id: 'in_x' } }, t.deps),
    ).toBe('ignored');
  });
});

describe('trials recorded from subscription events', () => {
  it('records a trialing subscription, and nothing for one that is not', async () => {
    const t = setup();
    expect(await handleEvent(t.event('customer.subscription.created', 1000), t.deps)).toBe(
      'processed',
    );
    expect(t.mirror.trials).toHaveLength(1);
    expect(t.sent).toHaveLength(0);

    const other = setup();
    other.sub.status = 'active';
    await handleEvent(other.event('customer.subscription.updated', 1000), other.deps);
    expect(other.mirror.trials).toHaveLength(0);
  });
});

describe('the trial_ending template', () => {
  it('renders the workspace and the date, nothing else', () => {
    const mail = renderTemplate(
      'trial_ending',
      TRIAL_ENDING_TEMPLATE as unknown as EmailTemplate<Record<string, unknown>>,
      { workspaceName: 'Acme', trialEnd: new Date(TRIAL_END * 1000) },
    );
    expect(mail.subject).toBe('Your Centcom trial ends soon');
    expect(mail.text).toContain('The Centcom trial of Acme ends on');
    expect(mail.html).toContain('Acme');
    expect(`${mail.text}${mail.html}`).not.toMatch(/@|\$|€|card/);
  });
});
