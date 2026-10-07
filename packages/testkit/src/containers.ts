/**
 * Test stack (B010): a migrated Postgres database and a Redis namespace for a test file, on the
 * servers DATABASE_URL and REDIS_URL point at (CI's service containers) or, without them, on
 * Postgres 16 and Redis 7 containers started once per process with testcontainers. Every stack
 * gets its own database (`test_<unix time>_<random>`) and Redis key prefix, so test files running
 * in parallel never see each other's data; `reset()` empties it between tests, `stop()` drops it.
 *
 * Owns: choosing the servers, the containers' lifecycle, the throwaway databases and reaping the
 * ones crashed runs left behind. Must not: touch a database whose name it did not make, start a
 * container when both URLs are set, or wait on a container runtime that is not there.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { defineConfig, keyPrefixFor, z, type Env } from '@centcom/core';
import { closeDb, createDb, migrate, MIGRATIONS_DIR, type CoreDatabase } from '@centcom/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { getContainerRuntimeClient, ImageName } from 'testcontainers';

/** Images the containers run. */
export const POSTGRES_IMAGE = 'postgres:16';
export const REDIS_IMAGE = 'redis:7';
/** A container that is not ready within this is stopped and reported with its last log lines. */
export const CONTAINER_STARTUP_TIMEOUT_MS = 60_000;
/** Throwaway databases older than this are dropped when a new stack starts (left by crashed runs). */
export const STALE_DATABASE_MS = 60 * 60 * 1000;
/** Labels on every container this kit starts. */
export const CONTAINER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'dev.centcom.testkit': 'true',
});

/** `test_<unix seconds>_<8 hex>`: the only database names this kit creates, resets or drops. */
const DATABASE_NAME = /^test_(\d{10})_[0-9a-f]{8}$/;

/** Why a stack could not start. */
export class TestStackError extends Error {}
Object.defineProperty(TestStackError.prototype, 'name', {
  value: 'TestStackError',
  writable: true,
  configurable: true,
});

const NO_RUNTIME =
  'No container runtime (Docker or Podman) is reachable, and DATABASE_URL and REDIS_URL are not both set. ' +
  'Start Docker, or set DATABASE_URL to a Postgres 16 where this user may CREATE DATABASE and REDIS_URL to a Redis 7.';

/** The servers stacks are created on. */
export interface TestServers {
  /** Postgres where the user may CREATE DATABASE. */
  databaseUrl: string;
  /** Redis. */
  redisUrl: string;
}

/** Starts the containers when no URLs are given; tests replace it. */
export interface ContainerRuntime {
  /** Resolves when a container runtime is reachable; rejects at once otherwise. */
  check(): Promise<void>;
  /** Pulls the images, so a later start measures only the start. */
  pull(): Promise<void>;
  startPostgres(): Promise<{ url: string; stop(): Promise<void> }>;
  startRedis(): Promise<{ url: string; stop(): Promise<void> }>;
}

/** Keeps a container's last 50 log lines, for the error when it fails to start. */
function logTail(): { consumer: (stream: NodeJS.ReadableStream) => void; text: () => string } {
  const lines: string[] = [];
  return {
    consumer: (stream) => {
      stream.pipe(
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            lines.push(...String(chunk).split('\n').filter(Boolean));
            lines.splice(0, Math.max(0, lines.length - 50));
            callback();
          },
        }),
      );
    },
    text: () => lines.join('\n'),
  };
}

/** The error for a container that did not come up, with its last log lines. */
const startFailure = (
  name: string,
  logs: ReturnType<typeof logTail>,
  cause: unknown,
): TestStackError =>
  new TestStackError(
    `The ${name} container did not start within ${CONTAINER_STARTUP_TIMEOUT_MS / 1000} s. Its last log lines:\n${logs.text() || '(none)'}`,
    { cause },
  );

/** The default runtime: testcontainers. Its reaper removes the containers when the process exits. */
export const testcontainersRuntime: ContainerRuntime = {
  async check() {
    try {
      await getContainerRuntimeClient();
    } catch (err) {
      throw new TestStackError(NO_RUNTIME, { cause: err });
    }
  },
  async pull() {
    const client = await getContainerRuntimeClient();
    await Promise.all(
      [POSTGRES_IMAGE, REDIS_IMAGE].map((image) => client.image.pull(ImageName.fromString(image))),
    );
  },
  async startPostgres() {
    const logs = logTail();
    try {
      const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withLabels({ ...CONTAINER_LABELS })
        .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
        .withLogConsumer(logs.consumer)
        .start();
      return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
    } catch (err) {
      throw startFailure('Postgres', logs, err);
    }
  },
  async startRedis() {
    const logs = logTail();
    try {
      const container = await new RedisContainer(REDIS_IMAGE)
        .withLabels({ ...CONTAINER_LABELS })
        .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
        .withLogConsumer(logs.consumer)
        .start();
      return { url: container.getConnectionUrl(), stop: async () => void (await container.stop()) };
    } catch (err) {
      throw startFailure('Redis', logs, err);
    }
  },
};

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

/** Where the servers came from, and how to stop what was started for them. */
interface ResolvedServers extends TestServers {
  source: 'env' | 'containers' | 'mixed';
}

/** Containers started in this process, by runtime: one Postgres and one Redis serve every stack. */
const containers = new WeakMap<ContainerRuntime, Promise<{ postgres?: string; redis?: string }>>();

/**
 * The servers stacks use: DATABASE_URL and REDIS_URL from `env` (default the process environment,
 * through the config loader) where set; containers for what is missing, started once per process.
 * When both URLs are set, the runtime is never asked for anything.
 */
export async function resolveTestServers(
  env?: Env,
  runtime: ContainerRuntime = testcontainersRuntime,
): Promise<ResolvedServers> {
  const fromEnv = defineConfig(envSchema, env);
  if (fromEnv.DATABASE_URL !== undefined && fromEnv.REDIS_URL !== undefined) {
    return { databaseUrl: fromEnv.DATABASE_URL, redisUrl: fromEnv.REDIS_URL, source: 'env' };
  }
  let started = containers.get(runtime);
  if (started === undefined) {
    started = (async () => {
      await runtime.check();
      const [postgres, redis] = await Promise.all([
        fromEnv.DATABASE_URL === undefined ? runtime.startPostgres() : undefined,
        fromEnv.REDIS_URL === undefined ? runtime.startRedis() : undefined,
      ]);
      return { postgres: postgres?.url, redis: redis?.url };
    })();
    containers.set(runtime, started);
    // A failed start is not cached: the next call tries again.
    started.catch(() => containers.delete(runtime));
  }
  const { postgres, redis } = await started;
  return {
    databaseUrl: fromEnv.DATABASE_URL ?? postgres ?? '',
    redisUrl: fromEnv.REDIS_URL ?? redis ?? '',
    source:
      fromEnv.DATABASE_URL === undefined && fromEnv.REDIS_URL === undefined
        ? 'containers'
        : 'mixed',
  };
}

/** A migrated database and a Redis namespace for one test file. */
export interface TestStack {
  /** The stack's own database. */
  databaseUrl: string;
  /** The Redis server (shared; use `redisKeyPrefix`). */
  redisUrl: string;
  /** This stack's Redis namespace, for `createRedis({ keyPrefix })`; `reset` and `stop` clear it. */
  redisKeyPrefix: string;
  /** The database's name: `test_<unix time>_<random>`. */
  databaseName: string;
  /** A client on the stack's database, migrated to the latest version. */
  db: Kysely<CoreDatabase>;
  /** Empties every application table (keeping `schema_migrations`) and the Redis namespace. */
  reset(): Promise<void>;
  /** Closes the client and drops the database and the Redis namespace. Idempotent. */
  stop(): Promise<void>;
}

/** Options for `startTestStack`. */
export interface TestStackOptions {
  /** Return this process's stack from an earlier `reuse` call instead of a new one. */
  reuse?: boolean;
  /** Where DATABASE_URL and REDIS_URL are read; default the process environment. */
  env?: Env;
  /** Starts containers when URLs are missing; default testcontainers. */
  runtime?: ContainerRuntime;
}

/** Throws unless `name` is a database this kit made. */
export function assertTestDatabaseName(name: string): void {
  if (!DATABASE_NAME.test(name)) {
    throw new TestStackError(
      `refusing to touch database ${JSON.stringify(name)}: only test_<time>_<random> databases made by the testkit`,
    );
  }
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Drops throwaway databases older than `maxAgeMs` on the server `databaseUrl` points at (default:
 * DATABASE_URL, read through the config loader; nothing happens when it is unset). Only names the
 * kit makes are touched. Returns the names dropped.
 */
export async function reapStaleTestDatabases(
  databaseUrl: string | undefined = defineConfig(envSchema).DATABASE_URL,
  maxAgeMs: number = STALE_DATABASE_MS,
  now: number = Date.now(),
): Promise<string[]> {
  if (databaseUrl === undefined) return [];
  return withClient(databaseUrl, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      "select datname as name from pg_database where datname like 'test\\_%'",
    );
    const stale = rows
      .map((r) => r.name)
      .filter((name) => {
        const match = DATABASE_NAME.exec(name);
        return match !== null && Number(match[1]) * 1000 < now - maxAgeMs;
      });
    for (const name of stale) {
      // A name cannot be a parameter; it matched DATABASE_NAME, and it is quoted.
      await client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
    }
    return stale;
  });
}

/** Deletes every key of a namespace (SCAN + UNLINK, so it never blocks Redis). */
async function clearNamespace(redisUrl: string, prefix: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

async function createStack(opts: TestStackOptions, onStop?: () => void): Promise<TestStack> {
  const servers = await resolveTestServers(opts.env, opts.runtime);
  const now = Date.now();
  const databaseName = `test_${Math.floor(now / 1000)}_${randomBytes(4).toString('hex')}`;
  await reapStaleTestDatabases(servers.databaseUrl, STALE_DATABASE_MS, now);
  await withClient(servers.databaseUrl, (c) =>
    c.query(`create database ${pg.escapeIdentifier(databaseName)}`),
  );
  const url = new URL(servers.databaseUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();
  const db = createDb<CoreDatabase>({
    url: databaseUrl,
    poolMax: 5,
    applicationName: 'centcom-testkit',
  });
  try {
    await migrate(db, MIGRATIONS_DIR);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  const redisKeyPrefix = keyPrefixFor(`test-${randomBytes(5).toString('hex')}`);
  let stopped = false;
  const stack: TestStack = {
    databaseUrl,
    redisUrl: servers.redisUrl,
    redisKeyPrefix,
    databaseName,
    db,
    async reset() {
      assertTestDatabaseName(databaseName);
      if (stopped) throw new TestStackError('the stack was stopped');
      const { rows } = await sql<{ name: string }>`
        select tablename as name from pg_tables
        where schemaname = 'public' and tablename <> 'schema_migrations'
      `.execute(db);
      if (rows.length > 0) {
        const hasAudit = rows.some((r) => r.name === 'audit_events');
        // audit_events refuses TRUNCATE (append-only trigger), also when a cascade reaches it. The
        // test database is disposable, so lift the trigger for this one transaction.
        await db.transaction().execute(async (trx) => {
          if (hasAudit) {
            await sql`alter table audit_events disable trigger audit_events_append_only`.execute(
              trx,
            );
          }
          await sql`truncate table ${sql.join(rows.map((r) => sql.table(r.name)))} restart identity cascade`.execute(
            trx,
          );
          if (hasAudit) {
            await sql`alter table audit_events enable trigger audit_events_append_only`.execute(
              trx,
            );
          }
        });
      }
      await clearNamespace(servers.redisUrl, redisKeyPrefix);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      onStop?.();
      assertTestDatabaseName(databaseName);
      await closeDb(db);
      await withClient(servers.databaseUrl, (c) =>
        c.query(`drop database if exists ${pg.escapeIdentifier(databaseName)} with (force)`),
      );
      await clearNamespace(servers.redisUrl, redisKeyPrefix).catch(() => undefined);
    },
  };
  return stack;
}

let reused: Promise<TestStack> | undefined;

/**
 * A migrated database and Redis namespace for a test file. With `reuse`, every call in this
 * process returns the same stack (the first call's options apply); call `reset()` between tests.
 * Without both DATABASE_URL and REDIS_URL and without a container runtime, rejects at once with a
 * TestStackError saying what to set.
 */
export function startTestStack(opts: TestStackOptions = {}): Promise<TestStack> {
  if (opts.reuse !== true) return createStack(opts);
  if (reused === undefined) {
    // A stopped or failed stack is not handed out again.
    const created: Promise<TestStack> = createStack(opts, () => {
      if (reused === created) reused = undefined;
    });
    reused = created;
    created.catch(() => {
      if (reused === created) reused = undefined;
    });
  }
  return reused;
}
