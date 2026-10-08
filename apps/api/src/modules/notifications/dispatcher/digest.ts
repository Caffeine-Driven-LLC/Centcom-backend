/**
 * The hourly e-mail digest (B063, CT-NOTIF-PAYLOAD "Email digests batch low/normal items hourly";
 * the worker's `notify.digest` job): for each user with items waiting, one e-mail with up to 50 of
 * them, oldest first, after which they are marked sent; items past 50 wait for the next run.
 * Taking, sending and marking are one transaction, so a failed send leaves the items for the next
 * run, and a run that finds nothing sends nothing: two runs in one hour send each item once. The
 * e-mail's idempotency key is derived from the items, so a send retried after a lost commit is
 * not delivered twice.
 *
 * Owns: batching. Must not: send an item twice, or stop every user's digest for one user's error.
 */
import { createHash } from 'node:crypto';
import { noopMetrics, type Logger, type Metrics, type NotificationCategory } from '@centcom/core';
import type { NotificationRecord } from '@centcom/db';
import type { EmailPort, NotificationPayload, NotificationStorePort } from './ports.js';

/** Items in one digest e-mail. */
export const DIGEST_MAX_ITEMS = 50;

/** What the digest needs. */
export interface DigestDeps {
  store: Pick<NotificationStorePort, 'usersWithPendingDigest' | 'takeDigest'>;
  email: EmailPort;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `notification_digests_sent_total` and `notification_digest_failures_total`. */
  metrics?: Metrics;
}

/** The payload of a stored notification. */
export function payloadOf(record: NotificationRecord): NotificationPayload {
  return {
    id: record.id,
    created_at: record.createdAt.toISOString(),
    read_at: record.readAt === null ? null : record.readAt.toISOString(),
    category: record.category as NotificationCategory,
    title_key: `notif.${record.category}.title`,
    body_key: `notif.${record.category}.body`,
    params: record.params,
    ...(record.action === null
      ? {}
      : { action: record.action as NonNullable<NotificationPayload['action']> }),
    priority: record.priority,
  };
}

/** One run; returns how many users got an e-mail and how many items went out. */
export async function runDigest(deps: DigestDeps): Promise<{ emails: number; items: number }> {
  const metrics = deps.metrics ?? noopMetrics;
  const now = new Date((deps.clock ?? Date.now)());
  let emails = 0;
  let items = 0;
  for (const userId of await deps.store.usersWithPendingDigest()) {
    try {
      const sent = await deps.store.takeDigest(userId, DIGEST_MAX_ITEMS, now, async (rows) => {
        const key = createHash('sha256')
          .update(rows.map((r) => r.id).join(','))
          .digest('hex')
          .slice(0, 32);
        await deps.email.enqueue(userId, 'notification_digest', {
          items: rows.map(payloadOf),
          idempotencyKey: `digest-${key}`,
        });
      });
      if (sent > 0) {
        emails++;
        items += sent;
        metrics.counter('notification_digests_sent_total').inc();
      }
    } catch (err) {
      metrics.counter('notification_digest_failures_total').inc();
      deps.logger?.warn(
        { user_id: userId, error: err instanceof Error ? err.name : typeof err },
        'notification.digest_failed',
      );
    }
  }
  deps.logger?.info({ emails, items }, 'notification.digest_run');
  return { emails, items };
}
