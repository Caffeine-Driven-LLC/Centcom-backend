/**
 * The control lane's Postgres ports (B051): `session_members` for the membership writes a
 * control frame makes, and `sessions` for ending a session. Every write is conditional on the
 * state the handler checked (a current member, the role it had), so a concurrent change turns it
 * into a no-op the handler sees (`false` / `null`) instead of a wrong write.
 *
 * Owns: the SQL. Must not: decide who may do what (`authority.ts`).
 */
import { createPostgresMembership } from '../rooms/membership.js';
import type { RelayDb } from '../modules.js';
import type { MembershipPort, SessionState, SessionStatePort } from './ports.js';

/** Thrown inside a transaction to roll it back. */
class Rollback extends Error {}

/** `MembershipPort` over `session_members`. */
export function createPostgresMembershipPort(db: RelayDb): MembershipPort {
  const source = createPostgresMembership(db);
  return {
    get: (sid, mid) => source.lookup(sid, mid),
    async remove(sid, mid, at) {
      const result = await db
        .updateTable('session_members')
        .set({ left_at: at })
        .where('id', '=', mid)
        .where('session_id', '=', sid)
        .where('left_at', 'is', null)
        .where('role', '!=', 'host')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async restore(sid, mid) {
      await db
        .updateTable('session_members')
        .set({ left_at: null })
        .where('id', '=', mid)
        .where('session_id', '=', sid)
        .execute();
    },
    async setRole(sid, mid, role) {
      const result = await db
        .updateTable('session_members')
        .set({ role })
        .where('id', '=', mid)
        .where('session_id', '=', sid)
        .where('left_at', 'is', null)
        .where('role', '!=', 'host')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async transferHost(sid, from, to) {
      try {
        await db.transaction().execute(async (trx) => {
          const swap = async (mid: string, was: 'host' | 'editor', becomes: 'host' | 'editor') => {
            const result = await trx
              .updateTable('session_members')
              .set({ role: becomes })
              .where('id', '=', mid)
              .where('session_id', '=', sid)
              .where('left_at', 'is', null)
              .where('role', '=', was)
              .executeTakeFirst();
            if (Number(result.numUpdatedRows) !== 1) throw new Rollback();
          };
          await swap(from, 'host', 'editor');
          await swap(to, 'editor', 'host');
        });
        return true;
      } catch (err) {
        if (err instanceof Rollback) return false;
        throw err;
      }
    },
    async members(sid) {
      const rows = await db
        .selectFrom('session_members')
        .select('id')
        .where('session_id', '=', sid)
        .where('left_at', 'is', null)
        .execute();
      return rows.map((r) => r.id);
    },
  };
}

/** `SessionStatePort` over `sessions`. */
export function createPostgresSessionState(db: RelayDb): SessionStatePort {
  return {
    async end(sid, at) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('sessions')
          .select('state')
          .where('id', '=', sid)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.state === 'ended' || row.state === 'expired') return null;
        await trx
          .updateTable('sessions')
          .set({ state: 'ended', ended_at: at })
          .where('id', '=', sid)
          .execute();
        return row.state as SessionState;
      });
    },
    async restore(sid, previous) {
      await db
        .updateTable('sessions')
        .set({ state: previous, ended_at: null })
        .where('id', '=', sid)
        .where('state', '=', 'ended')
        .execute();
    },
  };
}
