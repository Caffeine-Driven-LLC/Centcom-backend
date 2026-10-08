/**
 * Isolation and failures (B063, card test dispatcher.isolation.test.ts, acceptance 8 and the
 * failure modes): a throwing push sender stops neither the inbox row nor the e-mail; a failing
 * e-mail stops neither; preferences that cannot be read fall back to the defaults and never drop
 * security_alert or billing_issue; a queue that cannot be reached at publish is a retryable 503
 * and nothing is lost silently. (Retries and the dead-letter queue: apps/worker's
 * notify-dispatch.test.ts.)
 */
import { newId } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { DISPATCHER_DETAILS } from '../../../src/modules/notifications/dispatcher/index.js';
import { prefs, testDispatcher } from './helpers.js';

const approval = (user: string, session: string) => ({
  category: 'approval_needed' as const,
  recipients: { users: [user] },
  params: { session, agent: newId('agt'), risk: 'high' as const },
  priority: 'high' as const,
});

describe('channel isolation (acceptance 8)', () => {
  it('writes the inbox row and sends the e-mail when the push sender throws', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    t.preferences.set(user, prefs({ channels: { approval_needed: { email: true } } }));
    t.failures.push = true;
    await t.dispatcher.publish(approval(user, session));
    await t.drain();
    expect(t.store.rows).toHaveLength(1);
    expect(t.emails).toHaveLength(1);
    expect(t.recorded.count('notification_channel_failures_total', { channel: 'push' })).toBe(1);
    expect(t.captured.lines().some((l) => l['msg'] === 'notification.channel_failed')).toBe(true);
  });

  it('writes the inbox row and pushes when the e-mail fails', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    t.preferences.set(user, prefs({ channels: { approval_needed: { email: true } } }));
    t.failures.email = true;
    await t.dispatcher.publish(approval(user, session));
    await t.drain();
    expect(t.store.rows).toHaveLength(1);
    expect(t.pushes).toHaveLength(1);
    expect(t.recorded.count('notification_channel_failures_total', { channel: 'email' })).toBe(1);
  });

  it('keeps going for the other recipients when one channel fails', async () => {
    const t = testDispatcher();
    const users = [t.store.addUser(), t.store.addUser(), t.store.addUser()];
    t.failures.push = true;
    await t.dispatcher.publish({
      category: 'security_alert',
      recipients: { users },
      params: { kind: 'new_device' },
      priority: 'high',
    });
    for (const user of users)
      t.preferences.set(user, prefs({ channels: { security_alert: { push: true } } }));
    await t.drain();
    expect(t.store.rows.map((r) => r.userId).sort()).toEqual([...users].sort());
  });
});

describe('preferences that cannot be read', () => {
  it('fall back to the defaults, and never drop security_alert or billing_issue', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    t.preferences.set(user, prefs({ channels: { billing_issue: { email: false } } }));
    t.failures.preferences = true;
    await t.dispatcher.publish({
      category: 'security_alert',
      recipients: { users: [user] },
      params: { kind: 'new_device' },
    });
    await t.dispatcher.publish({
      category: 'billing_issue',
      recipients: { users: [user] },
      params: { kind: 'payment_failed' },
    });
    await t.drain();
    expect(t.store.rows.map((r) => [r.category, r.channels])).toEqual([
      ['security_alert', ['inbox']],
      ['billing_issue', ['email', 'inbox']],
    ]);
    // The defaults: billing_issue's e-mail goes, though the unread preference turned it off.
    expect(t.emails).toHaveLength(1);
    expect(t.recorded.count('notification_preferences_unavailable_total')).toBe(2);
    expect(
      t.captured.lines().filter((l) => l['msg'] === 'notification.preferences_unavailable'),
    ).toHaveLength(2);
  });
});

describe('the queue at publish', () => {
  it('is a retryable 503 when it cannot be reached, and nothing is written', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    t.failures.queue = true;
    const err = await t.dispatcher
      .publish({ category: 'trial_ending', recipients: { users: [user] }, params: { days: 1 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      retryAfterS: 1,
      detail: DISPATCHER_DETAILS.unavailable,
    });
    expect(t.store.rows).toEqual([]);
  });

  it('queues each event under its own id, which the job id repeats', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const ids = [
      await t.dispatcher.publish({
        category: 'trial_ending',
        recipients: { users: [user] },
        params: { days: 1 },
      }),
      await t.dispatcher.publish({
        category: 'trial_ending',
        recipients: { users: [user] },
        params: { days: 1 },
      }),
    ];
    expect(new Set(ids).size).toBe(2);
    expect(t.queued.map((j) => j.eventId)).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
