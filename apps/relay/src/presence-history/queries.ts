/**
 * Presence history on Postgres (B067): the writer the recorder flushes to, and the lookups other
 * backend lanes use (`lastSeen`, `recentSessions`; never a route).
 *
 * - **Writes** (one transaction per batch): `connected` and `disconnected` events go to
 *   `presence_log`; the newest event per member moves its `member_last_seen` row forward only (a
 *   write older than the row changes nothing, so out-of-order events cannot move it back), in
 *   multi-row statements. A `connected` event or a touch marks the member connected; a
 *   `disconnected` one, not. Online/offline is decided per node, as B047 does: a member whose
 *   connection on one node goes offline reads offline until its other node's next touch (at most a
 *   minute).
 * - **`lastSeen`:** the start of the current minute while the member is connected (its last write
 *   is under ONLINE_STALE_MS old, so a crashed node cannot keep it online), else its last-seen
 *   time; null when it never connected.
 * - **`recentSessions`:** the device's sessions, newest first, only those whose member has not
 *   left (a kicked member's row stays for audit, but its session is no longer the device's).
 *
 * Owns: the SQL. Must not: store a presence payload.
 */
import type { createDb, PresenceHistoryDatabase } from '@centcom/db';
import { purgeOlderThan } from './purge.js';
import {
  MAX_RECENT_SESSIONS,
  ONLINE_STALE_MS,
  TOUCH_EVERY_MS,
  type HistoryEvent,
  type PresenceHistory,
  type PresenceHistoryWriter,
} from './ports.js';

/** Members written per `member_last_seen` statement. */
const UPSERT_CHUNK = 1_000;

/** The relay's client typed for these tables. */
export type PresenceHistoryDb = ReturnType<typeof createDb<PresenceHistoryDatabase>>;

/** The writer over Postgres. */
export function createPostgresHistoryWriter(db: PresenceHistoryDb): PresenceHistoryWriter {
  return {
    async write(all) {
      if (all.length === 0) return;
      await db.transaction().execute(async (trx) => {
        // Sessions deleted meanwhile (a workspace purge) are skipped, so one cannot refuse the
        // others' batch; the live ones are held (FOR KEY SHARE) until the transaction ends.
        const sids = [...new Set(all.map((e) => e.sid))];
        const live = new Set(
          (
            await trx
              .selectFrom('sessions')
              .select('id')
              .where('id', 'in', sids)
              .forKeyShare()
              .execute()
          ).map((r) => r.id),
        );
        const events = all.filter((e) => live.has(e.sid));
        if (events.length === 0) return;
        const logged = events.filter(
          (e): e is Extract<HistoryEvent, { kind: 'connected' | 'disconnected' }> =>
            e.kind !== 'touch',
        );
        if (logged.length > 0) {
          await trx
            .insertInto('presence_log')
            .values(
              logged.map((e) => ({
                session_id: e.sid,
                member_id: e.memberId,
                device_id: e.deviceId,
                event: e.kind,
                reason: e.kind === 'disconnected' ? e.reason : null,
                at: e.at,
              })),
            )
            .execute();
        }
        // The newest event per member decides its row; on a tie, an online/offline event beats a
        // touch, and a later one in the batch beats an earlier one.
        const last = new Map<string, HistoryEvent>();
        for (const e of events) {
          const key = `${e.sid}/${e.memberId}`;
          const prev = last.get(key);
          const newer =
            prev === undefined ||
            e.at.getTime() > prev.at.getTime() ||
            (e.at.getTime() === prev.at.getTime() && (e.kind !== 'touch' || prev.kind === 'touch'));
          if (newer) last.set(key, e);
        }
        const rows = [...last.values()].map((e) => ({
          session_id: e.sid,
          member_id: e.memberId,
          device_id: e.deviceId,
          last_seen_at: e.at,
          connected: e.kind !== 'disconnected',
        }));
        // One statement per UPSERT_CHUNK members (each member once per statement).
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
          await trx
            .insertInto('member_last_seen')
            .values(rows.slice(i, i + UPSERT_CHUNK))
            .onConflict((oc) =>
              oc
                .columns(['session_id', 'member_id'])
                .doUpdateSet((eb) => ({
                  device_id: eb.ref('excluded.device_id'),
                  last_seen_at: eb.ref('excluded.last_seen_at'),
                  connected: eb.ref('excluded.connected'),
                }))
                .where('member_last_seen.last_seen_at', '<=', (eb) =>
                  eb.ref('excluded.last_seen_at'),
                ),
            )
            .execute();
        }
      });
    },
  };
}

/** The lookups over Postgres. */
export function createPostgresPresenceHistory(
  db: PresenceHistoryDb,
  clock: () => number = Date.now,
): PresenceHistory {
  return {
    async lastSeen(sid, memberId) {
      const row = await db
        .selectFrom('member_last_seen')
        .select(['last_seen_at', 'connected'])
        .where('session_id', '=', sid)
        .where('member_id', '=', memberId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const now = clock();
      if (row.connected && now - row.last_seen_at.getTime() < ONLINE_STALE_MS) {
        return new Date(Math.floor(now / TOUCH_EVERY_MS) * TOUCH_EVERY_MS);
      }
      return row.last_seen_at;
    },
    async recentSessions(deviceId, limit) {
      const n = Math.max(0, Math.min(Math.floor(limit), MAX_RECENT_SESSIONS));
      if (n === 0) return [];
      const rows = await db
        .selectFrom('member_last_seen as ls')
        .innerJoin('session_members as sm', (join) =>
          join.onRef('sm.id', '=', 'ls.member_id').onRef('sm.session_id', '=', 'ls.session_id'),
        )
        .select(['ls.session_id', 'ls.last_seen_at'])
        .where('ls.device_id', '=', deviceId)
        .where('sm.left_at', 'is', null)
        .orderBy('ls.last_seen_at', 'desc')
        .limit(n)
        .execute();
      return rows.map((r) => ({ sid: r.session_id, lastSeen: r.last_seen_at }));
    },
    purgeOlderThan: (cutoff) => purgeOlderThan(db, cutoff),
  };
}
