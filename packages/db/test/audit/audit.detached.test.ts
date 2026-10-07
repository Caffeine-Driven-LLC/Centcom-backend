/**
 * Detached audit events on Postgres 16 (B036, card test audit.detached.test.ts, acceptance 5;
 * DATABASE_URL, CI's integration job): flush(5000) writes a full queue of 1 000 events, in the
 * order they were emitted; and a batch holding an event for a workspace that does not exist
 * (refused by the foreign key) loses only that event, counted as rejected. The queue's limits,
 * timing and retries are covered without a database in packages/core/test/audit.
 */
import { newId } from '@centcom/contracts';
import { AUDIT_QUEUE_MAX, createAuditEmitter, type Metrics } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addWorkspace,
  ADMIN_URL,
  auditDatabase,
  event,
  type AuditTestDatabase,
} from './helpers.js';

/** A Metrics that counts `audit_events_dropped_total` by reason. */
function droppedCounter(): { metrics: Metrics; dropped: Map<string, number> } {
  const dropped = new Map<string, number>();
  return {
    dropped,
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => {
          if (name !== 'audit_events_dropped_total') return;
          const reason = labels?.['reason'] ?? '';
          dropped.set(reason, (dropped.get(reason) ?? 0) + n);
        },
      }),
      histogram: () => ({ observe: () => undefined }),
    },
  };
}

describe.runIf(ADMIN_URL !== undefined)('detached audit events on Postgres 16', () => {
  let t: AuditTestDatabase;
  beforeAll(async () => {
    t = await auditDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  /** The `meta.from_seats` of a workspace's events, in the order they happened. */
  const written = async (workspaceId: string): Promise<number[]> =>
    (
      await t.db
        .selectFrom('audit_events')
        .select('meta')
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    ).map((r) => Number(r.meta['from_seats']));

  it('writes every queued event on flush(5000), in the order emitted (acceptance 5)', async () => {
    const workspaceId = await addWorkspace(t.db, t.userId);
    const { metrics, dropped } = droppedCounter();
    const emitter = createAuditEmitter({ db: t.db, metrics });
    for (let i = 0; i < AUDIT_QUEUE_MAX; i++) {
      emitter.emitDetached(
        event(workspaceId, t.userId, { action: 'billing.seats', meta: { from_seats: i } }),
      );
    }
    await emitter.flush(5000);
    expect(await written(workspaceId)).toEqual(
      Array.from({ length: AUDIT_QUEUE_MAX }, (_, i) => i),
    );
    expect([...dropped.values()].reduce((a, b) => a + b, 0)).toBe(0);
  }, 30_000);

  it('drops only an event whose workspace does not exist, and writes the rest of its batch', async () => {
    const workspaceId = await addWorkspace(t.db, t.userId);
    const { metrics, dropped } = droppedCounter();
    const emitter = createAuditEmitter({ db: t.db, metrics });
    for (let i = 0; i < 5; i++) {
      const target = i === 2 ? newId('wsp') : workspaceId;
      emitter.emitDetached(
        event(target, t.userId, { action: 'billing.seats', meta: { from_seats: i } }),
      );
    }
    await emitter.flush(5000);
    expect(await written(workspaceId)).toEqual([0, 1, 3, 4]);
    expect(dropped.get('rejected')).toBe(1);
  }, 30_000);
});
