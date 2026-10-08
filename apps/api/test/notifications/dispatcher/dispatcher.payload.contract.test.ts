/**
 * The payload (B063, card test dispatcher.payload.contract.test.ts, acceptance 2): what dispatch
 * stores and hands to push and e-mail validates against CT-NOTIF-PAYLOAD's schema, holds exactly
 * its keys and no others, with `notif.<category>.title|body` keys and no display text, for every
 * category; the digest's payload of a stored row is the same.
 */
import { newId, validate } from '@centcom/contracts';
import type { NotificationEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { buildPayload, payloadOf } from '../../../src/modules/notifications/dispatcher/index.js';
import { testDispatcher } from './helpers.js';

const PAYLOAD_KEYS = [
  'action',
  'body_key',
  'category',
  'created_at',
  'id',
  'params',
  'priority',
  'read_at',
  'title_key',
];

const examples: NotificationEvent[] = [
  {
    category: 'approval_needed',
    recipients: { users: [] },
    params: { agent: newId('agt'), session: '', risk: 'medium' },
  },
  {
    category: 'queue_turn',
    recipients: { users: [] },
    params: { session: '', item: newId('que') },
  },
  { category: 'mention', recipients: { users: [] }, params: { session: '', from: newId('mem') } },
  {
    category: 'member_joined',
    recipients: { users: [] },
    params: { session: '', member: newId('mem') },
  },
  {
    category: 'member_left',
    recipients: { users: [] },
    params: { session: '', member: newId('mem') },
  },
  {
    category: 'agent_done',
    recipients: { users: [] },
    params: { session: '', agent: newId('agt'), outcome: 'succeeded' },
  },
  {
    category: 'ci_failed',
    recipients: { users: [] },
    params: { session: '', agent: newId('agt') },
  },
  {
    category: 'pr_merged',
    recipients: { users: [] },
    params: { session: '', agent: newId('agt') },
  },
  {
    category: 'usage_warning',
    recipients: { users: [] },
    params: { limit: 'hosted_minutes_month', pct: 80 },
  },
  {
    category: 'quota_reached',
    recipients: { users: [] },
    params: { limit: 'hosted_minutes_month' },
  },
  { category: 'billing_issue', recipients: { users: [] }, params: { kind: 'payment_failed' } },
  { category: 'trial_ending', recipients: { users: [] }, params: { days: 3 } },
  { category: 'invite_received', recipients: { users: [] }, params: { workspace: newId('wsp') } },
  {
    category: 'update_available',
    recipients: { users: [] },
    params: { version: '1.4.2', channel: 'stable' },
  },
  { category: 'security_alert', recipients: { users: [] }, params: { kind: 'new_device' } },
];

describe('the dispatched payload (acceptance 2)', () => {
  it('validates for every category and holds exactly the CT-NOTIF-PAYLOAD keys', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    t.preferences.set(user, {
      channels: Object.fromEntries(examples.map((e) => [e.category, { push: true }])),
      quiet_hours: { enabled: false },
    });
    for (const example of examples) {
      const params = { ...example.params };
      if ('session' in params) params['session'] = session;
      await t.dispatcher.publish({
        ...example,
        recipients: { users: [user] },
        params,
        action: { type: 'open_session', deeplink: `centcom://session/${session}?focus=approval` },
        priority: 'high',
      });
    }
    await t.drain();
    expect(t.pushes).toHaveLength(examples.length);
    for (const { payload } of t.pushes) {
      const result = validate('notification', payload);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
      expect(payload.title_key).toBe(`notif.${payload.category}.title`);
      expect(payload.body_key).toBe(`notif.${payload.category}.body`);
      expect(payload.read_at).toBeNull();
      expect(payload.id).toMatch(/^ntf_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    const approval = t.pushes.find((p) => p.payload.category === 'approval_needed');
    expect(approval?.payload.title_key).toBe('notif.approval_needed.title');
    // What the inbox stores reads back as the same payload.
    for (const row of t.store.rows) {
      const pushed = t.pushes.find((p) => p.payload.id === row.id)?.payload;
      expect(payloadOf(row)).toEqual(pushed);
    }
  });

  it('leaves out action when the event has none, and defaults the priority to normal', () => {
    const payload = buildPayload(
      { category: 'trial_ending', recipients: { users: [] }, params: { days: 2 } },
      newId('ntf'),
      new Date(Date.UTC(2026, 9, 7)),
    );
    expect(payload).toEqual({
      id: payload.id,
      created_at: '2026-10-07T00:00:00.000Z',
      read_at: null,
      category: 'trial_ending',
      title_key: 'notif.trial_ending.title',
      body_key: 'notif.trial_ending.body',
      params: { days: 2 },
      priority: 'normal',
    });
    expect(validate('notification', payload).ok).toBe(true);
  });

  it('never logs param values', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    await t.dispatcher.publish({
      category: 'update_available',
      recipients: { users: [user] },
      params: { version: '9.8.7', channel: 'secretchannel' },
    });
    await t.drain();
    expect(t.captured.raw()).not.toContain('9.8.7');
    expect(t.captured.raw()).not.toContain('secretchannel');
    expect(t.captured.lines().map((l) => l['msg'])).toEqual(
      expect.arrayContaining(['notification.published', 'notification.dispatched']),
    );
  });
});
