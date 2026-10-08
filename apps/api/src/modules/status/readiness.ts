/**
 * Readiness (B086, CT-STATUS `/readyz`): the API can serve when the database answers `SELECT 1`,
 * Redis answers `PING`, and the database's migrations are at least at the version this build
 * expects (B007's rule: a database ahead of the build is fine during a rolling deploy). Each check
 * gives up after READYZ_TIMEOUT_MS (1 s), so the answer comes within about a second whatever is
 * down. A missing migrations table fails `migrations` only.
 *
 * Owns: the checks. Must not: say a check's error, a host or a version in what it returns.
 */
import type { RedisBackend } from '@centcom/core';
import { currentMigrationVersion } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** Checks by name: `{ok: boolean}` only, as the relay's (B037). */
export type ReadinessChecks = Record<'db' | 'redis' | 'migrations', { ok: boolean }>;

/** The readiness answer. */
export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessChecks;
}

/** What the checks need. */
export interface ReadinessDeps<DB> {
  db: Kysely<DB>;
  redis: Pick<RedisBackend, 'ping'>;
  /** The version required (EXPECTED_MIGRATION_VERSION); null: none. */
  expectedVersion: string | null;
  /** READYZ_TIMEOUT_MS. */
  timeoutMs: number;
}

/** `work`'s value, or undefined when it fails or takes longer than `ms`. Never rejects. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work().then((value) => ({ value })), timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Checks readiness. */
export class Readiness<DB = unknown> {
  constructor(private readonly deps: ReadinessDeps<DB>) {}

  /** The three checks, run at once. Never rejects. */
  async check(): Promise<ReadinessReport> {
    const ms = this.deps.timeoutMs;
    const [db, redis, current] = await Promise.all([
      within(() => sql`select 1`.execute(this.deps.db), ms),
      within(() => this.deps.redis.ping(), ms),
      within(() => currentMigrationVersion(this.deps.db), ms),
    ]);
    const expected = this.deps.expectedVersion;
    const migrations =
      current !== undefined &&
      (expected === null || (current.value !== null && current.value >= expected));
    const checks: ReadinessChecks = {
      db: { ok: db !== undefined },
      redis: { ok: redis !== undefined },
      migrations: { ok: migrations },
    };
    return { ok: Object.values(checks).every((c) => c.ok), checks };
  }
}
