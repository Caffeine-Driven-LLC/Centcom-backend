/**
 * Params (B063, card test dispatcher.params.test.ts, acceptance 3): each category's allow-list
 * from CT-NOTIF-PAYLOAD; free text (a space, more than 64 characters) and keys outside the list
 * are refused at publish with a NotificationEventError naming pointers, never values, and nothing
 * is queued or written; the rest of the event is checked too; and a property test over random
 * params.
 */
import { newId } from '@centcom/contracts';
import { NOTIFICATION_CATEGORIES, type NotificationEvent } from '@centcom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  eventIssues,
  NotificationEventError,
  PARAM_RULES,
} from '../../../src/modules/notifications/dispatcher/index.js';
import { testDispatcher } from './helpers.js';

const USERS = { users: [newId('usr')] };
const event = (overrides: Partial<NotificationEvent>): NotificationEvent => ({
  category: 'mention',
  recipients: USERS,
  params: { session: newId('ses'), from: newId('mem') },
  ...overrides,
});

describe('the allow-lists', () => {
  it('cover every category with the keys CT-NOTIF-PAYLOAD names', () => {
    expect(Object.keys(PARAM_RULES).sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
    const keys = Object.fromEntries(
      Object.entries(PARAM_RULES).map(([category, rules]) => [category, Object.keys(rules).sort()]),
    );
    expect(keys).toEqual({
      approval_needed: ['agent', 'risk', 'session'],
      queue_turn: ['item', 'session'],
      mention: ['from', 'session'],
      member_joined: ['member', 'session'],
      member_left: ['member', 'session'],
      agent_done: ['agent', 'outcome', 'session'],
      ci_failed: ['agent', 'session'],
      pr_merged: ['agent', 'session'],
      usage_warning: ['limit', 'pct'],
      quota_reached: ['limit'],
      billing_issue: ['kind'],
      trial_ending: ['days'],
      invite_received: ['workspace'],
      update_available: ['channel', 'version'],
      security_alert: ['kind'],
    });
  });

  it('accepts ids of the right prefix, enum values, short tokens and integers in range', () => {
    const ok: NotificationEvent[] = [
      event({
        category: 'approval_needed',
        params: { agent: newId('agt'), session: newId('ses'), risk: 'high' },
      }),
      event({ category: 'queue_turn', params: { session: newId('ses'), item: newId('que') } }),
      event({
        category: 'agent_done',
        params: { session: newId('ses'), agent: newId('agt'), outcome: 'succeeded' },
      }),
      event({ category: 'usage_warning', params: { limit: 'hosted_minutes_month', pct: 80 } }),
      event({ category: 'billing_issue', params: { kind: 'card_expiring' } }),
      event({ category: 'trial_ending', params: { days: 3 } }),
      event({ category: 'invite_received', params: { workspace: newId('wsp') } }),
      event({ category: 'update_available', params: { version: '1.4.2', channel: 'stable' } }),
      event({ category: 'update_available', params: { version: '2.0.0-beta.1', channel: 'beta' } }),
      event({ category: 'security_alert', params: { kind: 'new_device' } }),
      event({ category: 'mention', params: {} }),
    ];
    for (const e of ok) expect(eventIssues(e)).toEqual([]);
  });
});

describe('refused at publish (acceptance 3)', () => {
  it.each([
    ['a value with a space', { session: newId('ses'), from: 'hello world' }, '/params/from'],
    ['a token longer than 64 characters', { limit: 'a'.repeat(65) }, '/params/limit'],
    ['free text where a token goes', { limit: 'Hosted minutes' }, '/params/limit'],
    ['a key outside the allow-list', { session: newId('ses'), text: 'x' }, '/params/text'],
    ['an id of another prefix', { session: newId('wsp') }, '/params/session'],
    ['an integer out of range', { pct: 1001 }, '/params/pct'],
    ['a fraction', { pct: 1.5 }, '/params/pct'],
    ['an unknown enum value', { kind: 'refund' }, '/params/kind'],
    ['a nested object', { session: { id: newId('ses') } }, '/params/session'],
  ])('%s', async (_name, params, pointer) => {
    const t = testDispatcher();
    const category =
      'pct' in params || 'limit' in params
        ? 'usage_warning'
        : 'kind' in params
          ? 'billing_issue'
          : 'mention';
    const err = await t.dispatcher
      .publish(event({ category, params: params as NotificationEvent['params'] }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationEventError);
    const issues = (err as NotificationEventError).issues;
    expect(issues.map((i) => i.pointer)).toContain(pointer);
    // Never the value itself.
    expect(JSON.stringify(issues) + (err as Error).message).not.toMatch(
      /hello world|Hosted minutes|aaaa/,
    );
    expect(t.queued).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });

  it('checks the category, recipients, priority, dedupe key and action as well', () => {
    const pointers = (e: unknown) => eventIssues(e).map((i) => i.pointer);
    expect(pointers(event({ category: 'nope' as never }))).toContain('/category');
    expect(pointers(event({ recipients: { users: [] } }))).toEqual(['/recipients/users']);
    expect(pointers(event({ recipients: { users: ['mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W'] } }))).toEqual([
      '/recipients/users',
    ]);
    expect(pointers(event({ recipients: { users: Array(1001).fill(newId('usr')) } }))).toEqual([
      '/recipients/users',
    ]);
    expect(pointers(event({ recipients: { workspace: newId('wsp'), roles: [] } }))).toEqual([
      '/recipients/roles',
    ]);
    expect(
      pointers(event({ recipients: { workspace: newId('wsp'), roles: ['root' as never] } })),
    ).toEqual(['/recipients/roles']);
    expect(
      pointers(event({ recipients: { session: newId('wsp'), members: [newId('mem')] } })),
    ).toEqual(['/recipients/session']);
    expect(pointers(event({ recipients: {} as never }))).toEqual(['/recipients']);
    expect(pointers(event({ priority: 'urgent' as never }))).toEqual(['/priority']);
    expect(pointers(event({ dedupeKey: 'has space' }))).toEqual(['/dedupeKey']);
    expect(
      pointers(event({ action: { type: 'open_session', deeplink: 'https://evil.test/' } })),
    ).toEqual(['/action/deeplink']);
    expect(
      pointers(event({ action: { type: 'open_session', deeplink: 'centcom://session/x#k=1' } })),
    ).toEqual(['/action/deeplink']);
    expect(pointers(event({ action: { type: 'explode' as never } }))).toEqual(['/action/type']);
    expect(pointers(null)).toEqual(['']);
    expect(pointers(event({ params: [] as never }))).toEqual(['/params']);
  });
});

describe('random params (property test)', () => {
  it('accepts only values the rules allow, and never throws', () => {
    const value = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.constantFrom(
        newId('ses'),
        newId('agt'),
        newId('mem'),
        newId('que'),
        newId('wsp'),
        'low',
        'card_expiring',
        '1.2.3',
      ),
      fc.integer({ min: -10, max: 5000 }),
      fc.double(),
      fc.boolean(),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...NOTIFICATION_CATEGORIES),
        fc.dictionary(
          fc.constantFrom('session', 'agent', 'risk', 'pct', 'limit', 'kind', 'days', 'note'),
          value,
        ),
        (category, params) => {
          const issues = eventIssues(
            event({ category, params: params as NotificationEvent['params'] }),
          );
          for (const [key, v] of Object.entries(params)) {
            const allowed = key in PARAM_RULES[category];
            const flagged = issues.some((i) => i.pointer === `/params/${key}`);
            if (!allowed) expect(flagged).toBe(true);
            if (typeof v === 'string' && (/\s/.test(v) || v.length > 64))
              expect(flagged).toBe(true);
            if (typeof v === 'boolean' || (typeof v === 'number' && !Number.isInteger(v))) {
              expect(flagged).toBe(true);
            }
          }
        },
      ),
      { numRuns: 2000, seed: 0x0b063 },
    );
  });
});
