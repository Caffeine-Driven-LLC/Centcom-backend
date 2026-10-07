/**
 * An in-memory stand-in for the few Postgres behaviours the runner, the health probe and
 * withTransaction rely on, as a Kysely dialect: the session-scoped advisory lock, the
 * `schema_migrations` table, transactions (commit applies, rollback discards) and injected
 * failures. It runs their control flow without a database, locally and in CI's `test` job. The
 * real-Postgres tests (DATABASE_URL set, CI's `integration` job) are the reference for every
 * acceptance criterion; this fake only mirrors the statements this package sends.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

interface Row {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/** A failure to raise when a statement contains `match`, `times` times. */
interface Failure {
  match: string;
  code: string;
  message: string;
  times: number;
}

/** The shared "server": what every fake connection sees. */
export class FakePostgres {
  /** Committed `schema_migrations` rows. */
  readonly rows: Row[] = [];
  /** Committed statements other than the bookkeeping ones (migration bodies, test queries). */
  readonly committed: string[] = [];
  /** Every statement received, whitespace collapsed and lower-cased. */
  readonly statements: string[] = [];
  /** Isolation level of every transaction begun (`default` when none was set). */
  readonly isolationLevels: string[] = [];
  hasTable = false;
  lockHolder: object | undefined;
  rollbacks = 0;
  /** Serialization failures to raise at the next commits. */
  commitFailures = 0;
  /** Milliseconds every non-bookkeeping statement takes. */
  statementDelayMs = 0;
  /** While true, every statement fails as a lost connection. */
  down = false;
  readonly #failures: Failure[] = [];

  /** Makes the next `times` statements containing `match` fail with SQLSTATE `code`. */
  failOn(match: string, code: string, times = Infinity, message = `forced ${code}`): void {
    this.#failures.push({ match, code, message, times });
  }

  /** A failure due for `sql`, used up by this call. */
  takeFailure(sql: string): Error | undefined {
    const failure = this.#failures.find((f) => f.times > 0 && sql.includes(f.match));
    if (failure === undefined) return undefined;
    failure.times -= 1;
    return Object.assign(new Error(failure.message), { code: failure.code });
  }

  /** A Kysely instance with its own connections to this server (another "process"). */
  connect<DB>(): Kysely<DB> {
    return new Kysely<DB>({ dialect: new FakeDialect(this) });
  }
}

interface FakeTransaction {
  rows: Row[];
  statements: string[];
}

class FakeConnection implements DatabaseConnection {
  tx: FakeTransaction | undefined;
  readonly #server: FakePostgres;

  constructor(server: FakePostgres) {
    this.#server = server;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const server = this.#server;
    const text = query.sql.replace(/\s+/g, ' ').trim().toLowerCase();
    server.statements.push(text);
    const result = (rows: unknown[]): QueryResult<R> => ({ rows: rows as R[] });
    if (server.down) throw new Error('Connection terminated unexpectedly');
    const failure = server.takeFailure(query.sql);
    if (failure !== undefined) throw failure;

    if (text.startsWith('select pg_try_advisory_lock(')) {
      if (server.lockHolder !== undefined && server.lockHolder !== this)
        return result([{ locked: false }]);
      server.lockHolder = this;
      return result([{ locked: true }]);
    }
    if (text.startsWith('select pg_advisory_unlock(')) {
      const held = server.lockHolder === this;
      if (held) server.lockHolder = undefined;
      return result([{ pg_advisory_unlock: held }]);
    }
    if (text.startsWith('create table if not exists schema_migrations')) {
      server.hasTable = true;
      return result([]);
    }
    if (text.startsWith("select to_regclass('schema_migrations')")) {
      return result([{ present: server.hasTable }]);
    }
    if (text.startsWith('select version, name, checksum, applied_at from schema_migrations')) {
      return result(
        [...server.rows].sort((a, b) => (a.version < b.version ? -1 : 1)).map((r) => ({ ...r })),
      );
    }
    if (text.startsWith('select max(version) as version from schema_migrations')) {
      const versions = server.rows.map((r) => r.version).sort();
      return result([{ version: versions.at(-1) ?? null }]);
    }
    if (text.startsWith('insert into schema_migrations')) {
      const [version, name, checksum] = query.parameters as string[];
      const row: Row = {
        version: version ?? '',
        name: name ?? '',
        checksum: checksum ?? '',
        applied_at: new Date(),
      };
      if ([...server.rows, ...(this.tx?.rows ?? [])].some((r) => r.version === row.version)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      }
      (this.tx?.rows ?? server.rows).push(row);
      return result([]);
    }
    if (text === 'select 1') return result([{ '?column?': 1 }]);
    // Anything else is a migration body or a test statement. Two Postgres behaviours the
    // fixtures use are mimicked: pg_sleep(s) takes s seconds, and 1 / 0 fails.
    const pause = /pg_sleep\(([\d.]+)\)/i.exec(query.sql);
    const delay = server.statementDelayMs + (pause === null ? 0 : Number(pause[1]) * 1000);
    if (delay > 0) await sleep(delay);
    if (/\b1\s*\/\s*0\b/.test(query.sql)) {
      throw Object.assign(new Error('division by zero'), { code: '22012' });
    }
    (this.tx?.statements ?? server.committed).push(query.sql);
    return result([]);
  }

  /** The package never streams; this only satisfies the interface. */
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    const iterator: AsyncIterableIterator<QueryResult<R>> = {
      next: () => Promise.reject(new Error('streaming is not supported by the fake')),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }
}

class FakeDriver implements Driver {
  readonly #server: FakePostgres;

  constructor(server: FakePostgres) {
    this.#server = server;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new FakeConnection(this.#server);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    (connection as FakeConnection).tx = { rows: [], statements: [] };
    this.#server.isolationLevels.push(settings.isolationLevel ?? 'default');
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as FakeConnection;
    const tx = conn.tx;
    if (this.#server.commitFailures > 0) {
      this.#server.commitFailures -= 1;
      throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    }
    conn.tx = undefined;
    if (tx === undefined) return;
    this.#server.rows.push(...tx.rows);
    this.#server.committed.push(...tx.statements);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    (connection as FakeConnection).tx = undefined;
    this.#server.rollbacks += 1;
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class FakeDialect implements Dialect {
  readonly #server: FakePostgres;

  constructor(server: FakePostgres) {
    this.#server = server;
  }

  createDriver(): Driver {
    return new FakeDriver(this.#server);
  }

  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }
}
