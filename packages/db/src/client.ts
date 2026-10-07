/**
 * Postgres client (B007): `createDb` builds a Kysely instance over a `pg` pool with the agreed
 * pool and session settings, `closeDb` ends it, and `poolStats` reports the pool's saturation.
 * A database that cannot be reached, and a pool with no free connection within the connect
 * timeout, reach callers as a typed 503 (`AppError('service_unavailable')`), never as raw driver
 * errors. Nothing connects until the first query.
 *
 * Owns: pool settings, session timeouts, the pool's error handling and metrics. Must not: log or
 * put into an error any SQL, query parameter or connection string, or expose a raw-SQL helper.
 */
import { performance } from 'node:perf_hooks';
import { AppError, noopMetrics, type Histogram, type Logger, type Metrics } from '@centcom/core';
import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type PostgresCursor,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from 'kysely';
import pg from 'pg';

/** Most connections in the pool. */
export const DEFAULT_POOL_MAX = 10;
/** An idle connection is closed after this long. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/**
 * The most a query waits for a connection: opening a new one, or getting one from a full pool.
 * Past it the query fails with a 503.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Postgres cancels a statement that runs longer (`statement_timeout`). */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
/** Postgres ends a session left idle inside a transaction this long (`idle_in_transaction_session_timeout`). */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
/** Upper bounds, in seconds, of the `db_pool_acquire_seconds` buckets. */
export const ACQUIRE_BUCKETS_S: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5,
]);

/** Settings for `createDb`. Entrypoints fill them from their configuration. */
export interface DbConfig {
  /** Postgres connection URL, such as `baseConfig().databaseUrl.reveal()`. Never logged. */
  url: string;
  /** Most connections in the pool; default DEFAULT_POOL_MAX (10). */
  poolMax?: number;
  /** Idle connection lifetime in ms; default DEFAULT_IDLE_TIMEOUT_MS (30 s). */
  idleTimeoutMs?: number;
  /** Wait for a connection in ms; default DEFAULT_CONNECT_TIMEOUT_MS (5 s). */
  connectTimeoutMs?: number;
  /** `statement_timeout` in ms, 0 for none; default DEFAULT_STATEMENT_TIMEOUT_MS (10 s). */
  statementTimeoutMs?: number;
  /** `idle_in_transaction_session_timeout` in ms; default DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS (15 s). */
  idleInTransactionTimeoutMs?: number;
  /** `application_name` shown in `pg_stat_activity`, such as the service name. */
  applicationName?: string;
  /**
   * Receives `db_pool_acquire_seconds` (wait for a connection), `db_pool_timeouts_total` (waits
   * for a full pool that gave up), `db_connection_errors_total` (connections that could not be
   * opened) and `db_connections_lost_total` (open connections that failed).
   */
  metrics?: Metrics;
  /** Writes a `db.connection_lost` warning when an open connection fails (the pool replaces it). */
  logger?: Logger;
}

/** The migration runner's bookkeeping table; one row per applied migration. */
export interface SchemaMigrationsTable {
  /** The file's 14-digit `yyyymmddhhmmss` version. */
  version: string;
  /** The file's snake_case name, without version and extension. */
  name: string;
  /** `sha256:<hex>` of the file as applied. */
  checksum: string;
  applied_at: ColumnType<Date, never, never>;
}

/**
 * The tables this package owns. Schema lanes describe theirs (B008's `CoreDatabase`, ...) and
 * pass their database type to `createDb<DB>()`.
 */
export interface Database {
  schema_migrations: SchemaMigrationsTable;
}

/** Connection numbers of a pool: `waiting` above 0 means it is saturated. */
export interface PoolStats {
  /** Configured maximum. */
  max: number;
  /** Open connections, idle or in use. */
  total: number;
  idle: number;
  /** Queries waiting for a connection. */
  waiting: number;
}

/** Network errors that mean the connection is gone, not that the query was wrong. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
/** SQLSTATEs (besides class 08, connection exception) that mean the server is going away. */
const SERVER_GONE_STATES = new Set(['57P01', '57P02', '57P03']);
const CONNECTION_LOST = /connection terminated|not queryable|connection ended/i;
const POOL_TIMEOUT = /timeout exceeded when trying to connect/i;

const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';

/** True if `err` says the connection to Postgres failed or was lost, rather than the query. */
export function isConnectionError(err: unknown): boolean {
  const code = codeOf(err);
  if (err instanceof pg.DatabaseError) {
    return code !== undefined && (code.startsWith('08') || SERVER_GONE_STATES.has(code));
  }
  return (
    (code !== undefined && CONNECTION_ERROR_CODES.has(code)) || CONNECTION_LOST.test(messageOf(err))
  );
}

/**
 * A copy of a driver error with only its name, message and code: other properties (a failed URL
 * parse keeps the URL in `input`) could hold the connection string.
 */
function sanitized(err: unknown): Error {
  const copy = new Error(messageOf(err));
  if (err instanceof Error && err.name !== 'Error') {
    Object.defineProperty(copy, 'name', { value: err.name, writable: true, configurable: true });
  }
  const code = codeOf(err);
  return code === undefined ? copy : Object.assign(copy, { code });
}

/** The 503 callers get when the database cannot be reached or the pool has no free connection. */
const unavailable = (err: unknown): AppError =>
  new AppError('service_unavailable', { cause: sanitized(err) });

/** One pooled connection as Kysely sees it; connection failures during a query become 503s. */
class GuardedClient implements PostgresPoolClient {
  readonly #client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    this.#client = client;
  }

  /** The backend pid, which Kysely uses to cancel an aborted query. */
  get processID(): number | undefined {
    return (this.#client as { processID?: number }).processID;
  }

  query<R>(sql: string, parameters: ReadonlyArray<unknown>): Promise<PostgresQueryResult<R>>;
  query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  query<R>(
    sqlOrCursor: string | PostgresCursor<R>,
    parameters?: ReadonlyArray<unknown>,
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    const client = this.#client as unknown as {
      query(...args: unknown[]): Promise<PostgresQueryResult<R>> | PostgresCursor<R>;
    };
    if (typeof sqlOrCursor !== 'string') return client.query(sqlOrCursor) as PostgresCursor<R>;
    return (client.query(sqlOrCursor, parameters) as Promise<PostgresQueryResult<R>>).catch(
      (err: unknown) => {
        throw isConnectionError(err) ? unavailable(err) : err;
      },
    );
  }

  /** Marks the connection as in use; `pg-pool` takes its own error listener off it meanwhile. */
  acquire(): void {
    this.checkedOut = true;
  }

  release(): void {
    // A connection that broke is not queryable; pg-pool sees that on release and closes it.
    this.checkedOut = false;
    this.#client.release();
  }

  /** True between connect() and release(). */
  checkedOut = false;
}

/** Records a connection that failed after it was established (the server went away, or killed it). */
type OnConnectionLost = (err: unknown, idle: boolean) => void;

/** The pool as Kysely sees it: acquiring a connection fails with a 503, timed and counted. */
class GuardedPool implements PostgresPool {
  readonly #pool: pg.Pool;
  readonly #metrics: Metrics;
  readonly #acquire: Histogram;
  readonly #onLost: OnConnectionLost;
  /** One wrapper per pooled connection, so Kysely's per-connection cache keeps working. */
  readonly #clients = new WeakMap<pg.PoolClient, GuardedClient>();

  constructor(pool: pg.Pool, metrics: Metrics, onLost: OnConnectionLost) {
    this.#pool = pool;
    this.#metrics = metrics;
    this.#onLost = onLost;
    this.#acquire = metrics.histogram('db_pool_acquire_seconds', ACQUIRE_BUCKETS_S);
  }

  get options(): object {
    return this.#pool.options;
  }

  get Client(): PostgresPool['Client'] {
    return (this.#pool as unknown as { Client?: PostgresPool['Client'] }).Client;
  }

  async connect(): Promise<PostgresPoolClient> {
    const start = performance.now();
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (err) {
      const timedOut = POOL_TIMEOUT.test(messageOf(err));
      this.#metrics
        .counter(timedOut ? 'db_pool_timeouts_total' : 'db_connection_errors_total')
        .inc();
      throw unavailable(err);
    } finally {
      this.#acquire.observe((performance.now() - start) / 1000);
    }
    let guarded = this.#clients.get(client);
    if (guarded === undefined) {
      const wrapper = new GuardedClient(client);
      // pg-pool listens for errors only on idle connections. One in use whose session dies
      // between queries (the server restarts, an operator kills it) emits 'error' with nobody
      // listening, which would crash the process; its next query fails with a 503 instead.
      // pg follows the server's FATAL with a second 'error' when the socket closes: count once.
      let lost = false;
      client.on('error', (err) => {
        if (!wrapper.checkedOut || lost) return;
        lost = true;
        this.#onLost(err, false);
      });
      this.#clients.set(client, wrapper);
      guarded = wrapper;
    }
    guarded.acquire();
    return guarded;
  }

  end(): Promise<void> {
    return this.#pool.end();
  }
}

/** The pools behind the Kysely instances createDb made, for closeDb and poolStats. */
const pools = new WeakMap<object, pg.Pool>();

function positiveInt(name: string, value: number | undefined, fallback: number, min = 1): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min) {
    throw new TypeError(`createDb: ${name} must be an integer of at least ${min}`);
  }
  return v;
}

/**
 * Creates a Kysely instance over a new `pg` pool. Nothing connects until the first query, so this
 * succeeds even while the database is down; queries then fail with a 503 AppError. Throws a
 * TypeError (that never quotes the URL) for a URL that is not `postgres://` or `postgresql://`, or
 * for a setting out of range.
 */
export function createDb<DB = Database>(cfg: DbConfig): Kysely<DB> {
  let protocol: string;
  try {
    protocol = new URL(cfg.url).protocol;
  } catch {
    throw new TypeError('createDb: url is not a valid URL');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new TypeError('createDb: url must be a postgres:// or postgresql:// URL');
  }
  const metrics = cfg.metrics ?? noopMetrics;
  const pool = new pg.Pool({
    connectionString: cfg.url,
    max: positiveInt('poolMax', cfg.poolMax, DEFAULT_POOL_MAX),
    idleTimeoutMillis: positiveInt('idleTimeoutMs', cfg.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: positiveInt(
      'connectTimeoutMs',
      cfg.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    statement_timeout: positiveInt(
      'statementTimeoutMs',
      cfg.statementTimeoutMs,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      0,
    ),
    idle_in_transaction_session_timeout: positiveInt(
      'idleInTransactionTimeoutMs',
      cfg.idleInTransactionTimeoutMs,
      DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      0,
    ),
    ...(cfg.applicationName === undefined ? {} : { application_name: cfg.applicationName }),
  });
  const lost = metrics.counter('db_connections_lost_total');
  const onLost: OnConnectionLost = (err, idle) => {
    lost.inc();
    cfg.logger?.warn({ err: sanitized(err), idle }, 'db.connection_lost');
  };
  // An idle pooled connection that fails emits 'error' on the pool; unhandled, it would crash
  // the process. The pool drops that connection and opens a new one when needed.
  pool.on('error', (err) => onLost(err, true));
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new GuardedPool(pool, metrics, onLost) }),
  });
  pools.set(db, pool);
  return db;
}

/** Closes every connection of a Kysely instance made by createDb; later queries fail. */
export async function closeDb<DB>(db: Kysely<DB>): Promise<void> {
  await db.destroy();
}

/**
 * The pool's connection numbers, for a saturation gauge (B093 exports them). Undefined for a
 * Kysely instance createDb did not return itself (including one derived with `withPlugin` and
 * the like).
 */
export function poolStats<DB>(db: Kysely<DB>): PoolStats | undefined {
  const pool = pools.get(db);
  if (pool === undefined) return undefined;
  return {
    max: pool.options.max ?? DEFAULT_POOL_MAX,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
