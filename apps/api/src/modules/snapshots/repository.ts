/**
 * The `snapshot` table over Postgres (B056, migration 20260102004600_snapshots.sql).
 *
 * - Begin takes `pg_advisory_xact_lock` on the session before it counts pending rows, so ten
 *   concurrent begins never pass the cap of 3.
 * - Every state change is a conditional UPDATE (`WHERE state = expected`), so two API instances (or
 *   a commit and a prune) never both win one row.
 * - Transactions hold no call to the object store (the service does those outside).
 *
 * Owns: the SQL. Must not: hold a transaction across a network call, or store anything about the
 * content but its size, hash and key id.
 */
import { withTransaction } from '@centcom/db';
import { sql, type ColumnType, type Kysely, type Selectable } from 'kysely';
import type { SnapshotRow, SnapshotRows, SnapshotState } from './ports.js';

/** The `snapshot` table's columns. */
export interface SnapshotTable {
  snp: string;
  session_id: string;
  state: ColumnType<SnapshotState, SnapshotState | undefined, SnapshotState>;
  seq: ColumnType<string | null, number | null | undefined, number | null>;
  size: number;
  sha256: string | null;
  kid: string | null;
  blob_key: string;
  created_at: ColumnType<Date, Date, Date>;
  committed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** The tables this module reads and writes. */
export interface SnapshotsDb {
  snapshot: SnapshotTable;
}

const COLUMNS = [
  'snp',
  'session_id',
  'state',
  'seq',
  'size',
  'sha256',
  'kid',
  'blob_key',
  'created_at',
  'committed_at',
] as const;

/** A row as the service sees it (`bigint` seq comes back as a string). */
function rowOf(r: Selectable<SnapshotTable>): SnapshotRow {
  return {
    snp: r.snp,
    sessionId: r.session_id,
    state: r.state,
    seq: r.seq === null ? null : Number(r.seq),
    size: r.size,
    sha256: r.sha256,
    kid: r.kid,
    blobKey: r.blob_key,
    createdAt: r.created_at,
    committedAt: r.committed_at,
  };
}

/** `SnapshotRows` over `db`. */
export function createSnapshotRepository(db: Kysely<SnapshotsDb>): SnapshotRows {
  return {
    insertPending(row, maxPending, pendingSince, audit) {
      return withTransaction(db, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`snapshot:${row.sessionId}`}, 0))`.execute(
          trx,
        );
        const pending = await trx
          .selectFrom('snapshot')
          .select('created_at')
          .where('session_id', '=', row.sessionId)
          .where('state', '=', 'pending')
          .where('created_at', '>=', pendingSince)
          .orderBy('created_at')
          .execute();
        if (pending.length >= maxPending) return pending[0]?.created_at ?? pendingSince;
        await trx
          .insertInto('snapshot')
          .values({
            snp: row.snp,
            session_id: row.sessionId,
            state: 'pending',
            size: row.size,
            kid: row.kid,
            blob_key: row.blobKey,
            created_at: row.createdAt,
          })
          .execute();
        await audit(trx);
        return true;
      });
    },

    async get(sid, snp) {
      const r = await db
        .selectFrom('snapshot')
        .select(COLUMNS)
        .where('snp', '=', snp)
        .where('session_id', '=', sid)
        .executeTakeFirst();
      return r === undefined ? null : rowOf(r);
    },

    commit(sid, snp, fields, audit) {
      return withTransaction(db, async (trx) => {
        const r = await trx
          .updateTable('snapshot')
          .set({
            state: 'committed',
            seq: fields.seq,
            sha256: fields.sha256,
            kid: fields.kid,
            committed_at: fields.committedAt,
          })
          .where('snp', '=', snp)
          .where('session_id', '=', sid)
          .where('state', '=', 'pending')
          .returning(COLUMNS)
          .executeTakeFirst();
        if (r === undefined) return null;
        await audit(trx);
        return rowOf(r);
      });
    },

    async latest(sid) {
      const r = await db
        .selectFrom('snapshot')
        .select(COLUMNS)
        .where('session_id', '=', sid)
        .where('state', '=', 'committed')
        .orderBy('seq', 'desc')
        .orderBy('committed_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r === undefined ? null : rowOf(r);
    },

    async beyondNewest(sid, keep) {
      // The latest (what GET serves) always stays; then the most recent commits.
      const top = await db
        .selectFrom('snapshot')
        .select('snp')
        .where('session_id', '=', sid)
        .where('state', '=', 'committed')
        .orderBy('seq', 'desc')
        .orderBy('committed_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (top === undefined) return [];
      const rows = await db
        .selectFrom('snapshot')
        .select(COLUMNS)
        .where('session_id', '=', sid)
        .where('state', '=', 'committed')
        .where('snp', '<>', top.snp)
        .orderBy('committed_at', 'desc')
        .orderBy('snp', 'desc')
        .offset(Math.max(keep - 1, 0))
        .execute();
      return rows.map(rowOf);
    },

    async expiredPending(before, limit, sid) {
      let query = db
        .selectFrom('snapshot')
        .select(COLUMNS)
        .where('state', '=', 'pending')
        .where('created_at', '<', before);
      if (sid !== undefined) query = query.where('session_id', '=', sid);
      const rows = await query.orderBy('created_at').limit(limit).execute();
      return rows.map(rowOf);
    },

    async deleting(limit, sid) {
      let query = db.selectFrom('snapshot').select(COLUMNS).where('state', '=', 'deleting');
      if (sid !== undefined) query = query.where('session_id', '=', sid);
      const rows = await query.orderBy('snp').limit(limit).execute();
      return rows.map(rowOf);
    },

    async allOf(sid) {
      const rows = await db
        .selectFrom('snapshot')
        .select(COLUMNS)
        .where('session_id', '=', sid)
        .orderBy('snp')
        .execute();
      return rows.map(rowOf);
    },

    async markDeleting(snps, fromState) {
      if (snps.length === 0) return [];
      const rows = await db
        .updateTable('snapshot')
        .set({ state: 'deleting' })
        .where('snp', 'in', [...snps])
        .where('state', '=', fromState)
        .returning('snp')
        .execute();
      return rows.map((r) => r.snp);
    },

    async restorePending(snps) {
      if (snps.length === 0) return;
      await db
        .updateTable('snapshot')
        .set({ state: 'pending' })
        .where('snp', 'in', [...snps])
        .where('state', '=', 'deleting')
        .where('committed_at', 'is', null)
        .execute();
    },

    async remove(snps) {
      if (snps.length === 0) return;
      await db
        .deleteFrom('snapshot')
        .where('snp', 'in', [...snps])
        .execute();
    },
  };
}
