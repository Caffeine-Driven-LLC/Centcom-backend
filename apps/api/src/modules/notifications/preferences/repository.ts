/**
 * The SQL of notification preferences (B066): one row per user in `notification_pref`, read
 * whole and written whole.
 *
 * - `save` without a condition upserts and moves `version` up by one in the same statement, so
 *   concurrent writers each get their own version and the last one wins.
 * - `save` with expected versions writes only while the row is at one of them: version 0 means
 *   "no row yet" (an insert that does nothing on conflict), any other version is a compare-and-set
 *   update. It returns null when the row moved on (the caller's 412).
 *
 * Owns: the statements. Must not: write a row of another user than the caller's.
 */
import type { NotificationPrefDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** A stored document and its version. */
export interface StoredPreferences {
  doc: unknown;
  version: number;
}

/** Preference persistence. */
export interface PreferencesRepository {
  /** The user's row, or null when they never saved preferences. */
  find(userId: string): Promise<StoredPreferences | null>;
  /**
   * Writes `doc` at `now`; returns the new version. With `expected`, writes only while the
   * row's version is one of them (0: no row), and returns null otherwise.
   */
  save(
    userId: string,
    doc: Record<string, unknown>,
    now: Date,
    expected?: readonly number[],
  ): Promise<number | null>;
}

/** The repository on Postgres (table `notification_pref`, migration 20260102001900). */
export function createPreferencesRepository<DB extends NotificationPrefDb>(
  database: Kysely<DB>,
): PreferencesRepository {
  // Kysely's types are invariant in the database type; only `notification_pref` is touched.
  const db = database as unknown as Kysely<NotificationPrefDb>;

  return {
    async find(userId) {
      const row = await db
        .selectFrom('notification_pref')
        .select(['doc', 'version'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row === undefined ? null : { doc: row.doc, version: row.version };
    },

    async save(userId, doc, now, expected) {
      const json = JSON.stringify(doc);
      if (expected === undefined) {
        const row = await db
          .insertInto('notification_pref')
          .values({ user_id: userId, doc: json, updated_at: now, version: 1 })
          .onConflict((oc) =>
            oc.column('user_id').doUpdateSet({
              doc: (eb) => eb.ref('excluded.doc'),
              updated_at: (eb) => eb.ref('excluded.updated_at'),
              version: sql<number>`notification_pref.version + 1`,
            }),
          )
          .returning('version')
          .executeTakeFirstOrThrow();
        return row.version;
      }
      if (expected.includes(0)) {
        const inserted = await db
          .insertInto('notification_pref')
          .values({ user_id: userId, doc: json, updated_at: now, version: 1 })
          .onConflict((oc) => oc.column('user_id').doNothing())
          .returning('version')
          .executeTakeFirst();
        if (inserted !== undefined) return inserted.version;
      }
      const versions = expected.filter((v) => v > 0);
      if (versions.length === 0) return null;
      const updated = await db
        .updateTable('notification_pref')
        .set({ doc: json, updated_at: now, version: sql<number>`version + 1` })
        .where('user_id', '=', userId)
        .where('version', 'in', versions)
        .returning('version')
        .executeTakeFirst();
      return updated === undefined ? null : updated.version;
    },
  };
}
