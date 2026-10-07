/**
 * Database health (B007): `healthCheck(db)` answers whether the database can be queried and
 * whether its migrations are at least at the version this build expects, for `/readyz`
 * (CT-STATUS). `expectedMigrationVersion(dir)` is the newest migration file of a build.
 *
 * Owns: the readiness probe and its time limit. Must not: throw (failures are reported), wait
 * longer than its timeout, or change anything in the database.
 */
import { sql, type Kysely } from 'kysely';
import { currentMigrationVersion, latestMigrationVersion, MIGRATIONS_DIR } from './migrate.js';

/** How long `healthCheck` waits for the database by default. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/** What `healthCheck` found. */
export interface HealthReport {
  /** The database answered a query in time. */
  ok: boolean;
  /**
   * Every migration this build knows is applied: the newest applied version is the expected one
   * or newer. A database ahead of the build counts as ready, since migrations stay compatible with
   * the previous release (expand, migrate, contract). False when the database is behind, cannot
   * be reached, or the migration files cannot be read.
   */
  migrationsAtExpected: boolean;
  /** The newest migration file's version; null when there are none or they cannot be read. */
  expectedVersion: string | null;
  /** The newest applied version; null when none is applied or the database did not answer. */
  currentVersion: string | null;
}

/** Options for `healthCheck`. */
export interface HealthOptions {
  /** The migrations directory of this build; default packages/db/migrations. */
  dir?: string;
  /** How long to wait for the database; default DEFAULT_HEALTH_TIMEOUT_MS (2 s). */
  timeoutMs?: number;
}

/**
 * The newest migration version of `dir` (default packages/db/migrations): what `/readyz` expects
 * the database to have. '' when the directory has no migrations. Throws a MigrationError for a
 * missing directory or a badly named file.
 */
export function expectedMigrationVersion(dir: string = MIGRATIONS_DIR): string {
  return latestMigrationVersion(dir);
}

/** Resolves to undefined if `promise` takes longer than `ms`; never rejects. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes the database: one trivial query and a read of the newest applied migration, within
 * `timeoutMs`. Never throws: an unreachable or slow database gives `ok: false`.
 */
export async function healthCheck<DB>(
  db: Kysely<DB>,
  opts: HealthOptions = {},
): Promise<HealthReport> {
  let expected: string | null | undefined;
  try {
    expected = expectedMigrationVersion(opts.dir ?? MIGRATIONS_DIR) || null;
  } catch {
    expected = undefined; // unreadable or badly named files: the build itself is broken
  }
  const probe = within(
    (async () => {
      await sql`select 1`.execute(db);
      return currentMigrationVersion(db);
    })(),
    opts.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  );
  const answer = await probe;
  const current = answer?.value ?? null;
  const ok = answer !== undefined;
  return {
    ok,
    migrationsAtExpected:
      ok &&
      expected !== undefined &&
      (expected === null || (current !== null && current >= expected)),
    expectedVersion: expected ?? null,
    currentVersion: current,
  };
}
