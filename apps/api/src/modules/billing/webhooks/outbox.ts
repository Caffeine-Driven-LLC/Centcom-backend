/**
 * The billing outbox (B072): domain events written while a Stripe event is processed, published
 * after it, so nothing is lost between Postgres and the queues.
 *
 * - Webhook events (`billing.subscription.updated`, `billing.invoice.paid`,
 *   `billing.invoice.payment_failed`) go to B081's `emitWebhookEvent`, which checks them against
 *   CT-WEBHOOKS and fans them out to the workspace's endpoints.
 * - Notification requests (`notify.billing_issue`, B079's `notify.trial_ending`) go to B063's
 *   dispatcher (`NotifyPort.publish`) for the workspace's owner and billing members, with the
 *   invoice (or the subscription and its trial end) as the dedupe key.
 * - One row per `(type, dedupe_key)`: reprocessing an event, or another event about the same
 *   invoice, adds nothing. So `billing_issue` is requested once per invoice.
 * - `publishOutbox` drains unpublished rows in id order and marks each published after its
 *   publish succeeded; a failure stops the run (the next run retries it). Delivery is at least
 *   once; B081 and B063 de-duplicate by event id and dedupe key.
 *
 * Owns: the outbox and its publisher. Must not: put card data, e-mail addresses or names in a row.
 */
import type {
  Logger,
  Metrics,
  NotificationEvent,
  WebhookEventInput,
  WebhookEventType,
} from '@centcom/core';
import { noopMetrics } from '@centcom/core';
import type { StripeEventsDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** The outbox's entry types. */
export type OutboxType =
  | 'billing.subscription.updated'
  | 'billing.invoice.paid'
  | 'billing.invoice.payment_failed'
  | 'notify.billing_issue'
  | 'notify.trial_ending';

/** An entry to write. */
export interface OutboxEntry {
  type: OutboxType;
  workspaceId: string;
  /** Ids, enums, amounts and currencies only. */
  payload: Record<string, string | number>;
  /** With `type`, what makes the entry unique (an invoice id, an event id). */
  dedupeKey: string;
}

/** A stored entry. */
export interface OutboxRow extends OutboxEntry {
  id: string;
}

/** The outbox table. */
export interface OutboxStore {
  /** Writes the entry; false when one of its type and key exists. */
  add(entry: OutboxEntry): Promise<boolean>;
  /** Unpublished entries, oldest first. */
  pending(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string): Promise<void>;
}

/** The outbox in Postgres. */
export function createOutboxStore(db: Kysely<StripeEventsDatabase>): OutboxStore {
  return {
    async add(entry) {
      const result = await db
        .insertInto('billing_outbox')
        .values({
          type: entry.type,
          workspace_id: entry.workspaceId,
          payload: JSON.stringify(entry.payload),
          dedupe_key: entry.dedupeKey,
        })
        .onConflict((oc) => oc.columns(['type', 'dedupe_key']).doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
    },
    async pending(limit) {
      const rows = await db
        .selectFrom('billing_outbox')
        .select(['id', 'type', 'workspace_id', 'payload', 'dedupe_key'])
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: String(r.id),
        type: r.type as OutboxType,
        workspaceId: r.workspace_id,
        payload: r.payload as Record<string, string | number>,
        dedupeKey: r.dedupe_key,
      }));
    },
    async markPublished(id) {
      await db
        .updateTable('billing_outbox')
        .set({ published_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
    },
  };
}

/** B063's dispatcher, as billing uses it. */
export interface NotifyPort {
  publish(event: NotificationEvent): Promise<string>;
}

/** What the publisher needs. */
export interface PublishDeps {
  outbox: OutboxStore;
  /** B081's `emitWebhookEvent`. */
  emitWebhook(input: WebhookEventInput): Promise<unknown>;
  notify: NotifyPort;
  logger?: Logger;
  metrics?: Metrics;
}

/** Rows one run publishes at most. */
export const OUTBOX_BATCH = 100;

/** Publishes one row (see the module comment). */
async function publishRow(row: OutboxRow, deps: PublishDeps): Promise<void> {
  if (row.type === 'notify.billing_issue') {
    await deps.notify.publish({
      category: 'billing_issue',
      recipients: { workspace: row.workspaceId, roles: ['owner', 'billing'] },
      params: { kind: 'payment_failed' },
      priority: 'high',
      dedupeKey: `billing_issue:${row.dedupeKey}`,
    });
    return;
  }
  if (row.type === 'notify.trial_ending') {
    await deps.notify.publish({
      category: 'trial_ending',
      recipients: { workspace: row.workspaceId, roles: ['owner', 'billing'] },
      params: { days: Number(row.payload['days'] ?? 0) },
      dedupeKey: `trial_ending:${row.dedupeKey}`,
    });
    return;
  }
  await deps.emitWebhook({
    type: row.type as WebhookEventType,
    workspace: row.workspaceId,
    data: row.payload,
  });
}

/** Publishes pending rows; resolves to how many went out. */
export async function publishOutbox(deps: PublishDeps, limit = OUTBOX_BATCH): Promise<number> {
  const metrics = deps.metrics ?? noopMetrics;
  let published = 0;
  for (const row of await deps.outbox.pending(limit)) {
    try {
      await publishRow(row, deps);
    } catch (err) {
      metrics.counter('billing_outbox_publish_failures_total', { type: row.type }).inc();
      deps.logger?.warn(
        { outbox_id: row.id, type: row.type, error: err instanceof Error ? err.name : 'unknown' },
        'billing.outbox_publish_failed',
      );
      break;
    }
    await deps.outbox.markPublished(row.id);
    metrics.counter('billing_outbox_published_total', { type: row.type }).inc();
    published += 1;
  }
  return published;
}
