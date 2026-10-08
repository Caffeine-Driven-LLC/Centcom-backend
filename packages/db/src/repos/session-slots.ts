/**
 * Member slots (B031): the Postgres side of the relay's slot service.
 *
 * `assign` runs in one transaction that first locks the session's row, so concurrent assigns for
 * one session take turns on every relay node. One more statement then returns the member's
 * existing slot, else inserts the next one (slots are never freed, so the lowest free slot is one
 * past the highest), up to `cap`. Assigns for different sessions do not wait for each other. The
 * unique constraints stay as a second line of defence: a violation surfaces as SQLSTATE 23505 for
 * the caller to retry. Statements are bounded to 2 s.
 *
 * Owns: the SQL of slots. Must not: store anything but ids and slot numbers.
 */
import { sql, type Kysely } from 'kysely';
import type { SessionSlotDatabase } from '../schema/session-slots.js';
import { withTransaction } from '../tx.js';

/** How long one slot statement may take. */
export const SLOT_STATEMENT_TIMEOUT_MS = 2_000;

/** What `assign` came to. */
export type SlotAssignment =
  { kind: 'assigned'; slot: number; existing: boolean } | { kind: 'no_session' } | { kind: 'full' };

/** Slot persistence. */
export interface SessionSlotStore {
  /** The member's slot in the session, assigning the next one (below `cap`) on first call. */
  assign(sessionId: string, memberId: string, cap: number): Promise<SlotAssignment>;
  /** The member's slot, or null. */
  get(sessionId: string, memberId: string): Promise<number | null>;
  /** Every slot of the session, lowest first. */
  list(sessionId: string): Promise<{ memberId: string; slot: number }[]>;
  /** Deletes the session's slots (the retention job, before the session row); returns how many. */
  deleteForSession(sessionId: string): Promise<number>;
}

/** The store on Postgres (table `session_member_slots`, migration 20260102003100). */
export function createSessionSlotStore(db: Kysely<SessionSlotDatabase>): SessionSlotStore {
  return {
    assign(sessionId, memberId, cap) {
      return withTransaction(db, async (trx): Promise<SlotAssignment> => {
        await sql`set local statement_timeout = ${sql.lit(SLOT_STATEMENT_TIMEOUT_MS)}`.execute(trx);
        const session = await trx
          .selectFrom('sessions')
          .select('id')
          .where('id', '=', sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (session === undefined) return { kind: 'no_session' };
        // One round trip under the lock: the member's slot, or the next one inserted below the cap.
        const { rows } = await sql<{ held: number | null; inserted: number | null }>`
          with cur as (
            select max(slot) filter (where member_id = ${memberId}) as held,
                   coalesce(max(slot) + 1, 0)::int as next
            from session_member_slots
            where session_id = ${sessionId}
          ), ins as (
            insert into session_member_slots (session_id, member_id, slot)
            select ${sessionId}, ${memberId}, next from cur where held is null and next < ${cap}
            returning slot
          )
          select cur.held, (select slot from ins) as inserted from cur
        `.execute(trx);
        // `cur` aggregates, so there is always one row.
        const { held, inserted } = rows[0] ?? { held: null, inserted: null };
        if (held !== null) return { kind: 'assigned', slot: held, existing: true };
        if (inserted !== null) return { kind: 'assigned', slot: inserted, existing: false };
        return { kind: 'full' };
      });
    },

    async get(sessionId, memberId) {
      const row = await db
        .selectFrom('session_member_slots')
        .select('slot')
        .where('session_id', '=', sessionId)
        .where('member_id', '=', memberId)
        .executeTakeFirst();
      return row?.slot ?? null;
    },

    async list(sessionId) {
      const rows = await db
        .selectFrom('session_member_slots')
        .select(['member_id', 'slot'])
        .where('session_id', '=', sessionId)
        .orderBy('slot')
        .execute();
      return rows.map((row) => ({ memberId: row.member_id, slot: row.slot }));
    },

    async deleteForSession(sessionId) {
      const result = await db
        .deleteFrom('session_member_slots')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
