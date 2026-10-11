/**
 * Presence log retention (B067, CT-WS-PRESENCE; PII minimisation): `presence_log` rows are kept
 * LOG_RETENTION_MS (30 days). `purgeOlderThan(db, cutoff)` deletes the rows older than `cutoff`, in
 * batches of PURGE_BATCH so no single statement holds many locks, and returns how many went;
 * `member_last_seen` is never touched (its rows live as long as the session). B090 schedules it.
 *
 * Owns: the delete. Must not: touch last-seen rows.
 */
import type { createDb, PresenceHistoryDatabase } from '@centcom/db';
import { LOG_RETENTION_MS } from './ports.js';

/** Rows deleted per statement. */
export const PURGE_BATCH = 10_000;

/** The cutoff for `now`: 30 days back. */
export const retentionCutoff = (now: number): Date => new Date(now - LOG_RETENTION_MS);

/** Deletes `presence_log` rows older than `cutoff`; how many. */
export async function purgeOlderThan(
  db: ReturnType<typeof createDb<PresenceHistoryDatabase>>,
  cutoff: Date,
  batch: number = PURGE_BATCH,
): Promise<number> {
  if (!Number.isInteger(batch) || batch < 1)
    throw new RangeError('batch must be a whole number >= 1');
  let total = 0;
  for (;;) {
    const result = await db
      .deleteFrom('presence_log')
      .where('id', 'in', (qb) =>
        qb.selectFrom('presence_log').select('id').where('at', '<', cutoff).limit(batch),
      )
      .executeTakeFirst();
    const n = Number(result.numDeletedRows);
    total += n;
    if (n < batch) return total;
  }
}
