/**
 * Routing (B063, card test dispatcher.routing.test.ts): the default channels of each category
 * (acceptance 1), user switches, quiet hours (acceptance 4) and the categories nothing can keep out
 * of the inbox, as a matrix over category × priority × quiet × prefs; the quiet-hours clock in the
 * user's time zone; and the default routing end to end through publish and dispatch.
 */
import { newId } from '@centcom/contracts';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_PRIORITIES } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  decideChannels,
  defaultChannels,
  MANDATORY_CATEGORIES,
  quietHours,
} from '../../../src/modules/notifications/dispatcher/index.js';
import { ALWAYS_QUIET, prefs, testDispatcher } from './helpers.js';

const sorted = (set: Set<string>): string[] => [...set].sort();

describe('decideChannels', () => {
  it('routes by the contract defaults when the user set nothing', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const expected =
        category === 'approval_needed'
          ? ['inbox', 'os', 'push']
          : category === 'billing_issue'
            ? ['email', 'inbox']
            : ['inbox'];
      expect(
        sorted(decideChannels({ category, priority: 'normal', prefs: null, quiet: false })),
      ).toEqual(expected);
      expect([...defaultChannels(category)].sort()).toEqual(expected);
    }
  });

  it('follows the switches, but never takes the inbox from security_alert or billing_issue', () => {
    const off = prefs({
      channels: {
        mention: { inbox: false, push: true, email: true },
        security_alert: { inbox: false, push: true },
        billing_issue: { inbox: false, email: false },
        approval_needed: { push: false },
      },
    });
    const route = (category: (typeof NOTIFICATION_CATEGORIES)[number]) =>
      sorted(decideChannels({ category, priority: 'normal', prefs: off, quiet: false }));
    expect(route('mention')).toEqual(['email', 'push']);
    expect(route('security_alert')).toEqual(['inbox', 'push']);
    expect(route('billing_issue')).toEqual(['inbox']);
    expect(route('approval_needed')).toEqual(['inbox', 'os']);
    // trial_ending has no switches in CT-API-NOTIFY: the default.
    expect(route('trial_ending')).toEqual(['inbox']);
  });

  it('drops push and os in quiet hours, except a high approval_needed the user allowed (acceptance 4)', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const priority of NOTIFICATION_PRIORITIES) {
        for (const allow of [false, true]) {
          const user = prefs({
            channels: { [category]: { inbox: true, push: true, email: true, os: true } },
            quiet_hours: ALWAYS_QUIET(allow),
          });
          const quiet = decideChannels({ category, priority, prefs: user, quiet: true });
          const loud = decideChannels({ category, priority, prefs: user, quiet: false });
          expect(sorted(loud)).toEqual(['email', 'inbox', 'os', 'push']);
          const keepsPush =
            MANDATORY_CATEGORIES.has(category) ||
            (category === 'approval_needed' && priority === 'high' && allow);
          expect(sorted(quiet)).toEqual(
            keepsPush ? ['email', 'inbox', 'os', 'push'] : ['email', 'inbox'],
          );
        }
      }
    }
  });

  it('gives approval_needed inbox only in quiet hours at normal priority, push at high with opt-in', () => {
    const quietUser = prefs({ quiet_hours: ALWAYS_QUIET(true) });
    expect(
      sorted(
        decideChannels({
          category: 'approval_needed',
          priority: 'normal',
          prefs: quietUser,
          quiet: true,
        }),
      ),
    ).toEqual(['inbox']);
    expect(
      sorted(
        decideChannels({
          category: 'approval_needed',
          priority: 'high',
          prefs: quietUser,
          quiet: true,
        }),
      ),
    ).toEqual(['inbox', 'os', 'push']);
    const noOptIn = prefs({ quiet_hours: ALWAYS_QUIET(false) });
    expect(
      sorted(
        decideChannels({
          category: 'approval_needed',
          priority: 'high',
          prefs: noOptIn,
          quiet: true,
        }),
      ),
    ).toEqual(['inbox']);
    for (const category of ['security_alert', 'billing_issue'] as const) {
      expect(
        sorted(decideChannels({ category, priority: 'low', prefs: noOptIn, quiet: true })),
      ).toEqual(
        sorted(decideChannels({ category, priority: 'low', prefs: noOptIn, quiet: false })),
      );
    }
  });
});

describe('quietHours', () => {
  const at = (iso: string) => new Date(iso);
  const window = (start: string, end: string, timezone?: string) =>
    prefs({
      quiet_hours: { enabled: true, start, end, ...(timezone === undefined ? {} : { timezone }) },
    });

  it('is on inside the window, in the user time zone, across midnight too', () => {
    const night = window('22:00', '07:00', 'Europe/Berlin');
    // 21:30 UTC is 23:30 in Berlin (CEST, UTC+2).
    expect(quietHours.isQuiet(night, at('2026-10-07T21:30:00Z'))).toBe(true);
    expect(quietHours.isQuiet(night, at('2026-10-07T04:59:00Z'))).toBe(true);
    expect(quietHours.isQuiet(night, at('2026-10-07T05:00:00Z'))).toBe(false);
    expect(quietHours.isQuiet(night, at('2026-10-07T12:00:00Z'))).toBe(false);
    const lunch = window('12:00', '13:00');
    expect(quietHours.isQuiet(lunch, at('2026-10-07T12:00:00Z'))).toBe(true);
    expect(quietHours.isQuiet(lunch, at('2026-10-07T13:00:00Z'))).toBe(false);
  });

  it('is off when disabled, empty, malformed, and falls back to UTC for an unknown zone', () => {
    const now = at('2026-10-07T12:30:00Z');
    expect(
      quietHours.isQuiet(
        prefs({ quiet_hours: { enabled: false, start: '00:00', end: '23:59' } }),
        now,
      ),
    ).toBe(false);
    expect(quietHours.isQuiet(prefs({ quiet_hours: { enabled: true } }), now)).toBe(false);
    expect(quietHours.isQuiet(window('12:00', '12:00'), now)).toBe(false);
    expect(quietHours.isQuiet(window('25:00', '13:00'), now)).toBe(false);
    expect(quietHours.isQuiet(window('12:00', '13:00', 'Not/A_Zone'), now)).toBe(true);
  });
});

describe('dispatching with the default routing (acceptance 1)', () => {
  it('approval_needed: one inbox row and one push; billing_issue: inbox and one e-mail, no push; mention: inbox only', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    await t.dispatcher.publish({
      category: 'approval_needed',
      recipients: { users: [user] },
      params: { agent: newId('agt'), session, risk: 'medium' },
      priority: 'high',
    });
    await t.drain();
    expect(t.store.rows).toHaveLength(1);
    expect(t.store.rows[0]?.channels).toEqual(['inbox', 'os', 'push']);
    expect(t.pushes).toHaveLength(1);
    expect(t.emails).toHaveLength(0);

    await t.dispatcher.publish({
      category: 'billing_issue',
      recipients: { users: [user] },
      params: { kind: 'payment_failed' },
    });
    await t.drain();
    expect(t.store.rows).toHaveLength(2);
    expect(t.pushes).toHaveLength(1);
    expect(t.emails).toEqual([
      expect.objectContaining({
        userId: user,
        template: 'notification',
        items: [expect.objectContaining({ category: 'billing_issue' })],
      }),
    ]);
    // An urgent e-mail goes now, not in the digest.
    expect(t.store.rows[1]?.digestPending).toBe(false);

    await t.dispatcher.publish({
      category: 'mention',
      recipients: { users: [user] },
      params: { session, from: newId('mem') },
    });
    await t.drain();
    expect(t.store.rows).toHaveLength(3);
    expect(t.store.rows[2]?.channels).toEqual(['inbox']);
    expect(t.pushes).toHaveLength(1);
    expect(t.emails).toHaveLength(1);
  });

  it('honours quiet hours for push, and puts low/normal e-mail items in the digest (acceptance 4)', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    t.preferences.set(
      user,
      prefs({ channels: { mention: { email: true } }, quiet_hours: ALWAYS_QUIET(true) }),
    );
    const approval = { agent: newId('agt'), session, risk: 'low' as const };
    await t.dispatcher.publish({
      category: 'approval_needed',
      recipients: { users: [user] },
      params: approval,
    });
    await t.dispatcher.publish({
      category: 'approval_needed',
      recipients: { users: [user] },
      params: approval,
      priority: 'high',
    });
    await t.dispatcher.publish({
      category: 'mention',
      recipients: { users: [user] },
      params: { session },
    });
    await t.drain();
    expect(t.store.rows.map((r) => r.channels)).toEqual([
      ['inbox'],
      ['inbox', 'os', 'push'],
      ['email', 'inbox'],
    ]);
    expect(t.pushes).toHaveLength(1);
    expect(t.emails).toHaveLength(0);
    expect(t.store.rows[2]?.digestPending).toBe(true);
  });
});
