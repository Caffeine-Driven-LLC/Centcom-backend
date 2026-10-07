/**
 * The client (B007): settings validation without echoing the URL, lazy connection, a typed 503
 * for an unreachable database or an exhausted pool (failure modes), the statement timeout
 * (acceptance 7), session settings, a connection lost mid-session, and pool metrics. The network
 * cases use local sockets; the rest need a real Postgres 16 (DATABASE_URL set).
 */
import { Writable } from 'node:stream';
import { AppError, createLogger, type Metrics } from '@centcom/core';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  DEFAULT_POOL_MAX,
  isConnectionError,
  poolStats,
  type DbConfig,
} from '../../src/index.js';
import { FakePostgres } from './fake-postgres.js';
import { ADMIN_URL, closedPort, onDatabase, silentServer, tempDatabase } from './helpers.js';
import { wireServer } from './wire-server.js';

type Db = Kysely<Record<string, never>>;
const PASSWORD = ['pw', 'not', 'logged'].join('-');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function open(url: string, extra: Partial<DbConfig> = {}): Db {
  const db = createDb<Record<string, never>>({ url, ...extra });
  cleanups.push(() => closeDb(db));
  return db;
}

/** A Metrics that counts counters by name and keeps histogram observations. */
function recordingMetrics(): {
  metrics: Metrics;
  count: (name: string) => number;
  observed: (name: string) => number[];
} {
  const counts = new Map<string, number>();
  const observations = new Map<string, number[]>();
  return {
    metrics: {
      counter: (name) => ({ inc: (n = 1) => counts.set(name, (counts.get(name) ?? 0) + n) }),
      histogram: (name) => ({
        observe: (value) => observations.set(name, [...(observations.get(name) ?? []), value]),
      }),
    },
    count: (name) => counts.get(name) ?? 0,
    observed: (name) => observations.get(name) ?? [],
  };
}

describe('createDb settings', () => {
  it('refuses a URL that is not postgres:// without quoting it', () => {
    for (const url of [`not a url ${PASSWORD}`, `mysql://user:${PASSWORD}@localhost/db`, '']) {
      let err: unknown;
      try {
        createDb({ url });
      } catch (e) {
        err = e;
      }
      expect(err, url).toBeInstanceOf(TypeError);
      expect(String(err)).not.toContain(PASSWORD);
    }
  });

  it('refuses settings out of range', () => {
    const url = 'postgres://localhost/db';
    for (const bad of [
      { poolMax: 0 },
      { poolMax: 1.5 },
      { connectTimeoutMs: 0 },
      { idleTimeoutMs: -1 },
      { statementTimeoutMs: -1 },
      { idleInTransactionTimeoutMs: Number.NaN },
    ]) {
      expect(() => createDb({ url, ...bad }), JSON.stringify(bad)).toThrow(TypeError);
    }
    const db = open(url, { statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0, poolMax: 2 });
    expect(poolStats(db)?.max).toBe(2);
  });

  it('connects lazily: creating succeeds while the database is down, and opens nothing', async () => {
    const db = open(`postgres://centcom:${PASSWORD}@127.0.0.1:${await closedPort()}/centcom`);
    expect(poolStats(db)).toEqual({ max: DEFAULT_POOL_MAX, total: 0, idle: 0, waiting: 0 });
  });

  it('reports pool numbers only for instances it created', () => {
    expect(poolStats(new FakePostgres().connect())).toBeUndefined();
  });
});

describe('an unreachable database (failure mode)', () => {
  it('fails queries with a 503 AppError that carries no connection string', async () => {
    const { metrics, count, observed } = recordingMetrics();
    const db = open(`postgres://centcom:${PASSWORD}@127.0.0.1:${await closedPort()}/centcom`, {
      metrics,
    });
    const err = await sql`select 1`.execute(db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    const cause = (err as AppError).cause as Error & { code?: string };
    expect(cause.code).toBe('ECONNREFUSED');
    expect(Object.keys(cause)).toEqual(['code']);
    for (const text of [
      String(err),
      cause.message,
      JSON.stringify(err),
      (err as Error).stack ?? '',
    ]) {
      expect(text).not.toContain(PASSWORD);
    }
    expect(count('db_connection_errors_total')).toBe(1);
    expect(observed('db_pool_acquire_seconds')).toHaveLength(1);
  });

  it('gives up on a server that never answers after the connect timeout, and on queued queries too', async () => {
    const silent = await silentServer();
    cleanups.push(silent.close);
    const { metrics, count } = recordingMetrics();
    const db = open(silent.url, { poolMax: 1, connectTimeoutMs: 200, metrics });
    const started = performance.now();
    const results = await Promise.allSettled([
      sql`select 1`.execute(db),
      sql`select 2`.execute(db),
    ]);
    const elapsed = performance.now() - started;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: 'service_unavailable',
      });
    }
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    // The first query waited for a new connection, the second for a free one in the full pool.
    expect(count('db_connection_errors_total')).toBe(1);
    expect(count('db_pool_timeouts_total')).toBe(1);
  });
});

describe('lost connections, against a wire-protocol stub', () => {
  async function stubbed(): Promise<{
    server: Awaited<ReturnType<typeof wireServer>>;
    db: Db;
    count: (name: string) => number;
    lines: () => Record<string, unknown>[];
  }> {
    const server = await wireServer();
    cleanups.push(server.close);
    const chunks: string[] = [];
    const logger = createLogger({
      level: 'warn',
      service: 'db-test',
      version: 'test',
      destination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      }),
    });
    const { metrics, count } = recordingMetrics();
    const db = open(server.url, { logger, metrics });
    const lines = (): Record<string, unknown>[] =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { server, db, count, lines };
  }

  const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs queries through the real driver', async () => {
    const { db, server } = await stubbed();
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
    expect(server.sessions()).toBe(1);
    expect(poolStats(db)).toMatchObject({ total: 1, idle: 1, waiting: 0 });
  });

  it('survives a connection killed while it sits idle in the pool, and opens a new one', async () => {
    const { db, server, count, lines } = await stubbed();
    await sql`select 1`.execute(db);
    server.terminateAll();
    await settle();
    expect(count('db_connections_lost_total')).toBe(1);
    expect(lines()).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'db.connection_lost', idle: true }),
    ]);
    expect(JSON.stringify(lines())).not.toContain('unused@');
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });

  it('survives a connection killed while checked out between queries: the next query is a 503', async () => {
    const { db, server, count, lines } = await stubbed();
    await db.connection().execute(async (conn) => {
      await sql`select 1`.execute(conn);
      // No query is running, and pg-pool listens only on idle connections: without the
      // package's own listener, this FATAL would be an unhandled 'error' that ends the process.
      server.terminateAll();
      await settle();
      expect(count('db_connections_lost_total')).toBe(1);
      expect(lines()).toEqual([
        expect.objectContaining({ msg: 'db.connection_lost', idle: false }),
      ]);
      const err = await sql`select 1`.execute(conn).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    });
    // The broken connection was closed on release, not handed out again.
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
    expect(server.sessions()).toBe(1);
  });
});

describe('isConnectionError', () => {
  const dbError = (code: string): pg.DatabaseError =>
    Object.assign(new pg.DatabaseError('x', 1, 'error'), { code });

  it('is true for lost connections and servers going away', () => {
    for (const err of [
      dbError('08006'),
      dbError('08001'),
      dbError('57P01'),
      dbError('57P03'),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('Connection terminated unexpectedly'),
      new Error('Client has encountered a connection error and is not queryable'),
    ]) {
      expect(isConnectionError(err), String(err)).toBe(true);
    }
  });

  it('is false for errors about the query itself', () => {
    for (const err of [
      dbError('57014'),
      dbError('23505'),
      dbError('40001'),
      dbError('42P01'),
      new TypeError('bad value'),
      'text',
      null,
    ]) {
      expect(isConnectionError(err), String(err)).toBe(false);
    }
  });
});

describe.runIf(ADMIN_URL !== undefined)('the client against Postgres 16', () => {
  async function database(): Promise<string> {
    const { url, drop } = await tempDatabase();
    cleanups.push(drop);
    return url;
  }

  const setting = async (
    db: Db,
    name: 'statement_timeout' | 'idle_in_transaction_session_timeout' | 'application_name',
  ) =>
    (await sql<{ value: string }>`select current_setting(${name}) as value`.execute(db)).rows[0]
      ?.value;

  it('opens sessions with the agreed timeouts, or the ones given', async () => {
    const url = await database();
    const db = open(url);
    expect(await setting(db, 'statement_timeout')).toBe('10s');
    expect(await setting(db, 'idle_in_transaction_session_timeout')).toBe('15s');
    const custom = open(url, {
      statementTimeoutMs: 1_500,
      idleInTransactionTimeoutMs: 2_000,
      applicationName: 'centcom-test',
    });
    expect(await setting(custom, 'statement_timeout')).toBe('1500ms');
    expect(await setting(custom, 'idle_in_transaction_session_timeout')).toBe('2s');
    expect(await setting(custom, 'application_name')).toBe('centcom-test');
  });

  it('cancels a query that runs past the statement timeout (acceptance 7)', async () => {
    const db = open(await database(), { statementTimeoutMs: 1_000 });
    const started = performance.now();
    const err = await sql`select pg_sleep(2)`.execute(db).catch((e: unknown) => e);
    const elapsed = performance.now() - started;
    expect(err).toMatchObject({ code: '57014' }); // query_canceled, a query error: not a 503
    expect(err).not.toBeInstanceOf(AppError);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1_900);
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });

  it('fails a query with a 503 after waiting at most the connect timeout for a full pool (failure mode)', async () => {
    const { metrics, count } = recordingMetrics();
    const db = open(await database(), { poolMax: 1, connectTimeoutMs: 300, metrics });
    const holding = sql`select pg_sleep(1)`.execute(db);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = performance.now();
    const waiting = sql`select 1`.execute(db).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(poolStats(db)).toMatchObject({ max: 1, total: 1, waiting: 1 });
    const err = await waiting;
    const elapsed = performance.now() - started;
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(900);
    expect(count('db_pool_timeouts_total')).toBe(1);
    await holding;
    expect(poolStats(db)).toMatchObject({ waiting: 0 });
  });

  it('turns a connection lost mid-session into a 503 without crashing, then carries on with a new one', async () => {
    const url = await database();
    const db = open(url, { applicationName: 'lost-mid-session' });
    await db.connection().execute(async (conn) => {
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(conn)).rows[0]
        ?.pid;
      await onDatabase(url, (c) => c.query('select pg_terminate_backend($1)', [pid]));
      // Let the server's FATAL reach the idle, checked-out connection: with no listener on it,
      // pg would emit an unhandled 'error' here and crash the test process.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(sql`select 1`.execute(conn)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    });
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });

  it('survives an idle pooled connection being killed, and logs it without the URL', async () => {
    const url = await database();
    const chunks: string[] = [];
    const logger = createLogger({
      level: 'warn',
      service: 'db-test',
      version: 'test',
      destination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      }),
    });
    const { metrics, count } = recordingMetrics();
    const db = open(url, { applicationName: 'killed-while-idle', logger, metrics });
    await sql`select 1`.execute(db);
    await onDatabase(url, (c) =>
      c.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'killed-while-idle'",
      ),
    );
    for (let i = 0; i < 50 && count('db_connections_lost_total') === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(count('db_connections_lost_total')).toBe(1);
    const line = JSON.parse(chunks.find((c) => c.includes('db.connection_lost')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({ level: 'warn', msg: 'db.connection_lost', idle: true });
    expect(chunks.join('')).not.toContain(new URL(url).password || '\u0000');
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });
});
