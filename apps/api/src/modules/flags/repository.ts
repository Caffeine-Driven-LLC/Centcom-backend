/**
 * The flags' SQL (B083): `feature_flags` and the global revision in `feature_flags_meta`.
 *
 * - `load` reads every flag with the revision in one statement, so the two always agree.
 * - `upsert` and `remove` lock the revision row, check the limits (at most `maxCount` flags; the
 *   client-visible flags' JSON within `maxBodyBytes`), change the flag, add exactly 1 to the
 *   revision, and run the caller's audit write, all in one transaction.
 *
 * Owns: these statements. Must not: change a flag without moving the revision.
 */
import type { AuditDb } from '@centcom/core';
import { withTransaction, type FlagDatabase } from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FlagDef, FlagRow } from './definition.js';

/** A stored flag, as read. */
export interface StoredRow extends FlagRow {
  updated_by: string;
  updated_at: Date;
}

/** Every flag at one revision. */
export interface FlagsAtRev {
  rev: number;
  rows: StoredRow[];
}

/** Limits a change is checked against. */
export interface ChangeLimits {
  /** Flags stored, at most (FLAGS_MAX_COUNT). */
  maxCount: number;
  /** Bytes of the client-visible flags' keys and values, at most (the response's budget). */
  maxBodyBytes: number;
}

/** Why a change was refused. */
export class FlagLimitError extends Error {
  override name = 'FlagLimitError';
  constructor(readonly limit: 'count' | 'body') {
    super(`flag limit reached: ${limit}`);
  }
}

/** Writes a change's audit event in its transaction. */
export type FlagAudit = (trx: AuditDb, previous: StoredRow | null, rev: number) => Promise<unknown>;

/** The flags' persistence. */
export interface FlagRepository {
  /** Every flag and the revision, read together. */
  load(): Promise<FlagsAtRev>;
  /** The revision. */
  rev(): Promise<number>;
  /** Creates or replaces `def`; FlagLimitError past a limit. */
  upsert(
    def: Required<FlagDef>,
    by: string,
    now: Date,
    limits: ChangeLimits,
    audit: FlagAudit,
  ): Promise<{ rev: number; previous: StoredRow | null }>;
  /** Deletes flag `key`; null (nothing changed) when there is none. */
  remove(key: string, audit: FlagAudit): Promise<{ rev: number; previous: StoredRow } | null>;
}

/** The bytes a flag adds to a response: `"key":` and the larger of its two values, and a comma. */
export const flagBytes = (key: string, value: unknown, fallback: unknown): number =>
  Buffer.byteLength(key, 'utf8') +
  4 +
  Math.max(
    Buffer.byteLength(JSON.stringify(value), 'utf8'),
    Buffer.byteLength(JSON.stringify(fallback), 'utf8'),
  );

const COLUMNS = [
  'key',
  'type',
  'value',
  'default_value',
  'public',
  'server_only',
  'kill',
  'rules',
  'updated_by',
  'updated_at',
] as const;

type Db = Kysely<FlagDatabase>;

/** Locks the revision row and adds 1 to it; returns the new revision. */
async function bump(trx: Transaction<FlagDatabase>): Promise<number> {
  const row = await trx
    .updateTable('feature_flags_meta')
    .set({ rev: sql<string>`rev + 1` })
    .where('id', '=', true)
    .returning('rev')
    .executeTakeFirstOrThrow();
  return Number(row.rev);
}

/** The repository over Postgres. */
export function createFlagRepository(db: Db): FlagRepository {
  return {
    async load() {
      const rows = await db
        .selectFrom('feature_flags_meta as m')
        .leftJoin('feature_flags as f', (join) => join.onTrue())
        .select('m.rev')
        .select(COLUMNS.map((c) => `f.${c}` as const))
        .execute();
      const rev = Number(rows[0]?.rev ?? 0);
      return { rev, rows: rows.filter((r) => r.key !== null) as unknown as StoredRow[] };
    },

    async rev() {
      const row = await db
        .selectFrom('feature_flags_meta')
        .select('rev')
        .where('id', '=', true)
        .executeTakeFirstOrThrow();
      return Number(row.rev);
    },

    upsert(def, by, now, limits, audit) {
      return withTransaction(db, async (trx) => {
        // The revision row serialises every change, so the limits hold under concurrency.
        await trx
          .selectFrom('feature_flags_meta')
          .select('rev')
          .where('id', '=', true)
          .forUpdate()
          .execute();
        const previous =
          (await trx
            .selectFrom('feature_flags')
            .select(COLUMNS)
            .where('key', '=', def.key)
            .executeTakeFirst()) ?? null;
        if (previous === null) {
          const { n } = await trx
            .selectFrom('feature_flags')
            .select(sql<string>`count(*)`.as('n'))
            .executeTakeFirstOrThrow();
          if (Number(n) >= limits.maxCount) throw new FlagLimitError('count');
        }
        if (!def.server_only) {
          const { bytes } = await trx
            .selectFrom('feature_flags')
            .select(
              sql<string>`coalesce(sum(octet_length(key) + 4 + greatest(octet_length(value::text), octet_length(default_value::text))), 0)`.as(
                'bytes',
              ),
            )
            .where('server_only', '=', false)
            .where('key', '<>', def.key)
            .executeTakeFirstOrThrow();
          if (Number(bytes) + flagBytes(def.key, def.value, def.default) > limits.maxBodyBytes) {
            throw new FlagLimitError('body');
          }
        }
        const values = {
          type: def.type,
          value: JSON.stringify(def.value),
          default_value: JSON.stringify(def.default),
          public: def.public,
          server_only: def.server_only,
          kill: def.kill,
          rules: JSON.stringify(def.rules),
          updated_by: by,
          updated_at: now,
        };
        await trx
          .insertInto('feature_flags')
          .values({ key: def.key, ...values })
          .onConflict((oc) => oc.column('key').doUpdateSet(values))
          .execute();
        const rev = await bump(trx);
        await audit(trx, previous as StoredRow | null, rev);
        return { rev, previous: previous as StoredRow | null };
      });
    },

    remove(key, audit) {
      return withTransaction(db, async (trx) => {
        await trx
          .selectFrom('feature_flags_meta')
          .select('rev')
          .where('id', '=', true)
          .forUpdate()
          .execute();
        const previous = await trx
          .deleteFrom('feature_flags')
          .where('key', '=', key)
          .returning(COLUMNS)
          .executeTakeFirst();
        if (previous === undefined) return null;
        const rev = await bump(trx);
        await audit(trx, previous as StoredRow, rev);
        return { rev, previous: previous as StoredRow };
      });
    },
  };
}
