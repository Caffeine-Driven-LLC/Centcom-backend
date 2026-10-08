/**
 * The hourly digest (B063, card test dispatcher.digest.test.ts, acceptance 7): one e-mail per user
 * with the waiting low/normal e-mail items (at most 50 in one), marked sent; nothing when nothing
 * waits; a second run in the same hour sends nothing; a failed send leaves the items for the next
 * run and does not stop the other users. On Postgres 16 (CI), two runs at once send each item once.
 */
import { newId } from '@centcom/contracts';
import { createNotificationStore, type NewNotification, type NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  DIGEST_MAX_ITEMS,
  runDigest,
  type EmailPort,
  type NotificationPayload,
} from '../../../src/modules/notifications/dispatcher/index.js';
import { prefs, T0, testDispatcher } from './helpers.js';
import { ADMIN_URL, migratedDatabase, pgUser } from './postgres.js';

/** An e-mail recorder that can fail for some users. */
function emailRecorder(failFor = new Set<string>()) {
  const sent: {
    userId: string;
    template: string;
    items: NotificationPayload[];
    idempotencyKey: string;
  }[] = [];
  const email: EmailPort = {
    enqueue: (userId, template, payload) => {
      if (failFor.has(userId)) return Promise.reject(new Error('email down'));
      sent.push({ userId, template, ...payload });
      return Promise.resolve();
    },
  };
  return { sent, email };
}

describe('the digest (acceptance 7)', () => {
  it('sends one e-mail per user with the waiting items, marks them, and nothing on a second run', async () => {
    const t = testDispatcher();
    const [a, b, quiet] = [t.store.addUser(), t.store.addUser(), t.store.addUser()];
    for (const user of [a, b])
      t.preferences.set(user, prefs({ channels: { usage_warning: { email: true } } }));
    for (let i = 0; i < 3; i++) {
      await t.dispatcher.publish({
        category: 'usage_warning',
        recipients: { users: [a] },
        params: { limit: 'hosted_minutes_month', pct: i },
      });
    }
    await t.dispatcher.publish({
      category: 'usage_warning',
      recipients: { users: [b, quiet] },
      params: { limit: 'hosted_minutes_month', pct: 9 },
      priority: 'low',
    });
    // High priority goes at once, not in the digest.
    await t.dispatcher.publish({
      category: 'usage_warning',
      recipients: { users: [a] },
      params: { limit: 'hosted_minutes_month', pct: 1 },
      priority: 'high',
    });
    await t.drain();
    expect(t.emails).toHaveLength(1);

    const { sent, email } = emailRecorder();
    const first = await runDigest({ store: t.store, email, clock: () => T0 + 3_600_000 });
    expect(first).toEqual({ emails: 2, items: 4 });
    expect(sent.map((s) => [s.userId, s.template, s.items.length])).toEqual(
      [
        [a, 'notification_digest', 3],
        [b, 'notification_digest', 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(sent.find((s) => s.userId === a)?.items.map((i) => i.params['pct'])).toEqual([0, 1, 2]);
    expect(t.store.rows.filter((r) => r.digestPending)).toEqual([]);
    expect(t.store.rows.filter((r) => r.digestSentAt !== null)).toHaveLength(4);

    const second = await runDigest({ store: t.store, email, clock: () => T0 + 3_600_001 });
    expect(second).toEqual({ emails: 0, items: 0 });
    expect(sent).toHaveLength(2);
  });

  it('puts at most 50 items in one e-mail; the rest go in the next', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    t.preferences.set(user, prefs({ channels: { usage_warning: { email: true } } }));
    for (let i = 0; i < 60; i++) {
      t.clock.now = T0 + i;
      await t.dispatcher.publish({
        category: 'usage_warning',
        recipients: { users: [user] },
        params: { limit: 'hosted_minutes_month', pct: i },
      });
    }
    await t.drain();
    const { sent, email } = emailRecorder();
    expect(await runDigest({ store: t.store, email })).toEqual({
      emails: 1,
      items: DIGEST_MAX_ITEMS,
    });
    expect(sent[0]?.items).toHaveLength(50);
    expect(await runDigest({ store: t.store, email })).toEqual({ emails: 1, items: 10 });
    expect(sent[1]?.items.map((i) => i.params['pct'])).toEqual(
      Array.from({ length: 10 }, (_, i) => 50 + i),
    );
  });

  it('sends nothing when nothing waits', async () => {
    const t = testDispatcher();
    const { sent, email } = emailRecorder();
    expect(await runDigest({ store: t.store, email })).toEqual({ emails: 0, items: 0 });
    expect(sent).toEqual([]);
  });

  it("leaves a failed user's items for the next run and still serves the others", async () => {
    const t = testDispatcher();
    const [failing, fine] = [t.store.addUser(), t.store.addUser()];
    for (const user of [failing, fine])
      t.preferences.set(user, prefs({ channels: { usage_warning: { email: true } } }));
    await t.dispatcher.publish({
      category: 'usage_warning',
      recipients: { users: [failing, fine] },
      params: { limit: 'hosted_minutes_month', pct: 1 },
    });
    await t.drain();
    const broken = emailRecorder(new Set([failing]));
    expect(await runDigest({ store: t.store, email: broken.email })).toEqual({
      emails: 1,
      items: 1,
    });
    expect(t.store.rows.find((r) => r.userId === failing)?.digestPending).toBe(true);
    const fixed = emailRecorder();
    expect(await runDigest({ store: t.store, email: fixed.email })).toEqual({
      emails: 1,
      items: 1,
    });
    expect(fixed.sent[0]?.userId).toBe(failing);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the digest on Postgres 16', () => {
  it('sends each item once when two runs overlap, and keeps items when the send fails', async () => {
    const t = await migratedDatabase(12);
    try {
      const store = createNotificationStore(t.db as unknown as Kysely<NotificationDb>);
      const users = [await pgUser(t.db), await pgUser(t.db), await pgUser(t.db)];
      const item = (userId: string, i: number): NewNotification => ({
        id: newId('ntf'),
        userId,
        eventId: `e${i}`,
        category: 'trial_ending',
        params: { days: i },
        priority: 'normal',
        action: null,
        channels: ['email', 'inbox'],
        dedupeKey: null,
        digestPending: true,
        createdAt: new Date(T0 + i),
      });
      for (const user of users) {
        for (let i = 0; i < 5; i++) await store.insert(item(user, i), 0);
      }
      const slow = emailRecorder();
      const delayed: EmailPort = {
        enqueue: async (userId, template, payload) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await slow.email.enqueue(userId, template, payload);
        },
      };
      const runs = await Promise.all([
        runDigest({ store, email: delayed }),
        runDigest({ store, email: delayed }),
      ]);
      expect(runs.reduce((n, r) => n + r.items, 0)).toBe(15);
      const ids = slow.sent.flatMap((s) => s.items.map((i) => i.id));
      expect(new Set(ids).size).toBe(15);
      expect(ids).toHaveLength(15);
      expect(await runDigest({ store, email: slow.email })).toEqual({ emails: 0, items: 0 });

      const user = await pgUser(t.db);
      await store.insert(item(user, 99), 0);
      const failing = emailRecorder(new Set([user]));
      expect(await runDigest({ store, email: failing.email })).toEqual({ emails: 0, items: 0 });
      expect((await store.forUser(user))[0]).toMatchObject({
        digestPending: true,
        digestSentAt: null,
      });
      const ok = emailRecorder();
      expect(await runDigest({ store, email: ok.email })).toEqual({ emails: 1, items: 1 });
      expect((await store.forUser(user))[0]).toMatchObject({ digestPending: false });
    } finally {
      await t.drop();
    }
  }, 60_000);
});
