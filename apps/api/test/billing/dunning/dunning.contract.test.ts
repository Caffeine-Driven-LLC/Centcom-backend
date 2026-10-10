/**
 * Dunning against its contracts and configuration (B078 test plan "contract: emitted
 * `plan_changed` notice and `billing.*` webhook events match CT-WS-SESSION-EVENTS and CT-WEBHOOKS
 * shapes"):
 *
 * - the `plan_changed` notice: the code and `{plan}` params of the Notices table in
 *   contracts/04-session-events.md, at the level its levels line gives (`info`), on
 *   `relay:notice:{wsp}`;
 * - the drop's `billing.subscription.updated` data passes B081's CT-WEBHOOKS checks;
 * - the `billing_issue` reminder passes B063's event checks (ids and enums only);
 * - the audit action: `billing.status` with `from`, `to`, `reason` only, outside the built-in
 *   catalogue (CT-API-AUDIT's stable list);
 * - the email template renders the workspace's name and the grace's end, and nothing else;
 * - configuration: 7 grace days and 10 wind-down minutes by default, anything else refused;
 * - the event types B072 hands over.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_ACTIONS,
  ConfigError,
  createTemplateRegistry,
  renderTemplate,
  webhookDataProblems,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  BILLING_STATUS_ACTION,
  DUNNING_AUDIT_ACTIONS,
  DUNNING_EVENT_TYPES,
  dunningNoticeChannel,
  loadDunningConfig,
  PAYMENT_FAILED_TEMPLATE,
  PAYMENT_FAILED_TEMPLATE_ID,
  PLAN_CHANGED_NOTICE,
  publishPlanChanged,
  statusAuditEvent,
} from '../../../src/modules/billing/dunning/index.js';
import { eventIssues } from '../../../src/modules/notifications/dispatcher/params.js';
import { newId } from './helpers.js';

const contract = readFileSync(
  fileURLToPath(new URL('../../../../../contracts/04-session-events.md', import.meta.url)),
  'utf8',
);

describe('the plan_changed notice (CT-WS-SESSION-EVENTS)', () => {
  it('carries the Notices table code and params, at its level, on the workspace channel', async () => {
    expect(contract).toMatch(/^\| `plan_changed` \| `\{plan\}` \|$/m);
    expect(contract).toMatch(/`plan_changed`→`info`/);
    expect(PLAN_CHANGED_NOTICE).toEqual({
      code: 'plan_changed',
      level: 'info',
      params: { plan: 'free' },
    });
    const published: [string, string][] = [];
    const ws = newId('wsp');
    await publishPlanChanged(
      {
        publish: (channel, message) => {
          published.push([channel, message]);
          return Promise.resolve();
        },
      },
      ws,
    );
    expect(published).toEqual([[`relay:notice:${ws}`, JSON.stringify(PLAN_CHANGED_NOTICE)]]);
    expect(dunningNoticeChannel(ws)).toBe(`relay:notice:${ws}`);
  });
});

describe('webhooks and notifications', () => {
  it('sends a drop as CT-WEBHOOKS billing.subscription.updated data, and reminders as B063 events', () => {
    expect(
      webhookDataProblems('billing.subscription.updated', {
        plan: 'free',
        status: 'none',
        seats: 1,
      }),
    ).toEqual([]);
    expect(
      eventIssues({
        category: 'billing_issue',
        recipients: { workspace: newId('wsp'), roles: ['owner', 'billing'] },
        params: { kind: 'payment_failed' },
        priority: 'high',
        dedupeKey: `billing_issue:dunning-${newId('wsp')}-1791460800000-day3`,
      }),
    ).toEqual([]);
  });
});

describe('the audit action', () => {
  it('is billing.status with from, to and reason, outside the built-in catalogue', () => {
    expect(Object.keys(AUDIT_ACTIONS)).not.toContain(BILLING_STATUS_ACTION);
    expect(DUNNING_AUDIT_ACTIONS[BILLING_STATUS_ACTION]).toEqual({
      meta: ['from', 'to', 'reason'],
    });
    const ws = newId('wsp');
    expect(
      statusAuditEvent(
        { workspace: ws, from: 'past_due', to: 'none', grace_until: null },
        'grace_expired',
      ),
    ).toEqual({
      workspaceId: ws,
      actor: { type: 'system', id: 'dunning' },
      action: 'billing.status',
      target: { type: 'workspace', id: ws },
      outcome: 'success',
      meta: { from: 'past_due', to: 'none', reason: 'grace_expired' },
    });
    expect(
      statusAuditEvent({ workspace: ws, from: 'active', to: 'past_due', grace_until: 'x' }).meta,
    ).toEqual({ from: 'active', to: 'past_due' });
  });
});

describe('the reminder email', () => {
  it('renders the workspace and the end of the grace, and no amount, card or invoice', () => {
    const templates = createTemplateRegistry();
    templates.registerTemplate(PAYMENT_FAILED_TEMPLATE_ID, PAYMENT_FAILED_TEMPLATE);
    const graceUntil = new Date(Date.UTC(2026, 9, 15, 12));
    const template = templates.get(PAYMENT_FAILED_TEMPLATE_ID);
    if (template === undefined) throw new Error('not registered');
    const rendered = renderTemplate(PAYMENT_FAILED_TEMPLATE_ID, template, {
      workspaceName: 'Acme <b>',
      graceUntil,
    });
    expect(rendered.subject).toBe('Your Centcom payment failed');
    expect(rendered.text).toContain('The latest payment for Acme <b> did not go through.');
    expect(rendered.html).toContain('Acme &lt;b&gt;');
    expect(rendered.text).toMatch(/2026/);
    expect(`${rendered.text}${rendered.html}`).not.toMatch(/€|\$\d|EUR|in_[A-Za-z0-9]|card/i);
  });
});

describe('configuration', () => {
  it('takes 7 grace days and 10 wind-down minutes, and refuses anything else', () => {
    expect(loadDunningConfig({})).toEqual({ graceDays: 7, windDownMs: 10 * 60 * 1000 });
    expect(loadDunningConfig({ DUNNING_GRACE_DAYS: '7', DUNNING_WINDDOWN_MIN: '10' })).toEqual({
      graceDays: 7,
      windDownMs: 600_000,
    });
    for (const env of [
      { DUNNING_GRACE_DAYS: '8' },
      { DUNNING_GRACE_DAYS: '6' },
      { DUNNING_WINDDOWN_MIN: '5' },
      { DUNNING_WINDDOWN_MIN: 'ten' },
    ]) {
      expect(() => loadDunningConfig(env)).toThrow(ConfigError);
    }
  });
});

describe('the events B072 hands over', () => {
  it('are the four the card names', () => {
    expect([...DUNNING_EVENT_TYPES].sort()).toEqual([
      'customer.subscription.deleted',
      'customer.subscription.updated',
      'invoice.paid',
      'invoice.payment_failed',
    ]);
  });
});
