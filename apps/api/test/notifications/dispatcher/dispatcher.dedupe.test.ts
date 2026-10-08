/**
 * De-duplication (B063, card test dispatcher.dedupe.test.ts, acceptance 5 and the idempotency
 * guardrail): two events with one (user, dedupe key) within 10 minutes make one notification,
 * after 10 minutes a second; dispatching one event again writes nothing more and sends nothing
 * again. On Postgres 16 (CI), the same, including ten events with one key dispatched at once.
 */
import { newId } from '@centcom/contracts';
import { createNotificationStore, type NewNotification, type NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { DEDUPE_WINDOW_MS } from '../../../src/modules/notifications/dispatcher/index.js';
import { T0, testDispatcher } from './helpers.js';
import { ADMIN_URL, migratedDatabase, pgUser } from './postgres.js';

const mention = (user: string, dedupeKey?: string) => ({
  category: 'mention' as const,
  recipients: { users: [user] },
  params: {},
  ...(dedupeKey === undefined ? {} : { dedupeKey }),
});

describe('the dedupe window (acceptance 5)', () => {
  it('makes one notification of two events with one key within 10 minutes, a second after', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    await t.dispatcher.publish(mention(user, 'ses_x:mention'));
    await t.drain();
    t.clock.now = T0 + DEDUPE_WINDOW_MS - 1;
    await t.dispatcher.publish(mention(user, 'ses_x:mention'));
    await t.drain();
    expect(t.store.rows).toHaveLength(1);
    expect(t.recorded.count('notifications_deduped_total')).toBe(1);
    t.clock.now = T0 + DEDUPE_WINDOW_MS;
    await t.dispatcher.publish(mention(user, 'ses_x:mention'));
    await t.drain();
    expect(t.store.rows).toHaveLength(2);
  });

  it('keeps keys apart per user and per key, and does not dedupe events without one', async () => {
    const t = testDispatcher();
    const [a, b] = [t.store.addUser(), t.store.addUser()];
    for (const event of [
      mention(a, 'k'),
      mention(b, 'k'),
      mention(a, 'other'),
      mention(a),
      mention(a),
    ]) {
      await t.dispatcher.publish(event);
    }
    await t.drain();
    expect(t.store.rows).toHaveLength(5);
  });

  it('writes and sends nothing more when one event is dispatched again (idempotent jobs)', async () => {
    const t = testDispatcher();
    const user = t.store.addUser();
    const session = newId('ses');
    t.store.joinSession(session, user);
    await t.dispatcher.publish({
      category: 'approval_needed',
      recipients: { users: [user] },
      params: { session, agent: newId('agt'), risk: 'low' },
    });
    const job = t.queued[0];
    if (job === undefined) throw new Error('nothing queued');
    await t.dispatcher.process(job);
    await t.dispatcher.process(job);
    t.clock.now = T0 + 60 * 60 * 1000;
    await t.dispatcher.process(job);
    expect(t.store.rows).toHaveLength(1);
    expect(t.pushes).toHaveLength(1);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the dedupe window on Postgres 16', () => {
  it('holds under concurrency, slides, and keeps one row per user and event', async () => {
    const t = await migratedDatabase(12);
    try {
      const store = createNotificationStore(t.db as unknown as Kysely<NotificationDb>);
      const user = await pgUser(t.db);
      const row = (
        eventId: string,
        at: number,
        dedupeKey: string | null = 'k',
      ): NewNotification => ({
        id: newId('ntf'),
        userId: user,
        eventId,
        category: 'mention',
        params: { from: newId('mem') },
        priority: 'normal',
        action: null,
        channels: ['inbox'],
        dedupeKey,
        digestPending: false,
        createdAt: new Date(at),
      });
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.insert(row(`e${i}`, T0), DEDUPE_WINDOW_MS)),
      );
      expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'deduped')).toHaveLength(9);
      expect(await store.insert(row('late', T0 + DEDUPE_WINDOW_MS - 1), DEDUPE_WINDOW_MS)).toBe(
        'deduped',
      );
      expect(await store.insert(row('after', T0 + DEDUPE_WINDOW_MS), DEDUPE_WINDOW_MS)).toBe(
        'inserted',
      );
      expect(await store.insert(row('plain', T0, null), DEDUPE_WINDOW_MS)).toBe('inserted');
      expect(await store.insert(row('plain', T0, null), DEDUPE_WINDOW_MS)).toBe('duplicate_event');
      const stored = await store.forUser(user);
      expect(stored).toHaveLength(3);
      expect(stored[0]).toMatchObject({
        category: 'mention',
        channels: ['inbox'],
        params: { from: expect.stringMatching(/^mem_/) },
      });
    } finally {
      await t.drop();
    }
  }, 60_000);
});
