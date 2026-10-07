/**
 * Test helpers for the users module (B013). With DATABASE_URL (CI's integration job): a
 * throwaway database per test file, named like the testkit's (`test_<unix seconds>_<hex>`) and
 * migrated to the latest version. Without it: a Kysely over a scripted driver, which records every
 * statement and answers with what the test says, for the paths that need no real Postgres.
 */
import { randomBytes } from 'node:crypto';
import { createIdGenerator, type IdPrefix } from '@centcom/contracts';
import { defineConfig, z } from '@centcom/core';
import {
  closeDb,
  createDb,
  migrate,
  MIGRATIONS_DIR,
  type CoreDatabase,
  type User,
} from '@centcom/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';

/** The Postgres to make throwaway databases on; undefined skips the real-Postgres tests. */
export const ADMIN_URL: string | undefined = defineConfig(
  z.object({ DATABASE_URL: z.string().optional() }),
).DATABASE_URL;

/** A migrated throwaway database. */
export interface TestDatabase {
  db: Kysely<CoreDatabase>;
  url: string;
  /** Closes `db` and drops the database. */
  drop(): Promise<void>;
}

async function onAdmin(statement: (admin: Kysely<unknown>) => Promise<unknown>): Promise<void> {
  if (ADMIN_URL === undefined) throw new Error('needs DATABASE_URL');
  const admin = createDb<unknown>({ url: ADMIN_URL, poolMax: 1 });
  try {
    await statement(admin);
  } finally {
    await closeDb(admin);
  }
}

/** A new database with every migration applied; `poolMax` defaults to 20. */
export async function migratedDatabase(poolMax = 20): Promise<TestDatabase> {
  if (ADMIN_URL === undefined) throw new Error('migratedDatabase needs DATABASE_URL');
  const name = `test_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString('hex')}`;
  await onAdmin((admin) => sql`create database ${sql.id(name)}`.execute(admin));
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = createDb<CoreDatabase>({
    url: url.toString(),
    poolMax,
    applicationName: 'api-users-test',
  });
  await migrate(db, MIGRATIONS_DIR);
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await closeDb(db);
      await onAdmin((admin) =>
        sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin),
      );
    },
  };
}

/** Row counts of the tables a sign-in writes. */
export async function counts(
  db: Kysely<CoreDatabase>,
): Promise<{ users: number; workspaces: number; memberships: number }> {
  const count = async (table: 'users' | 'workspaces' | 'memberships'): Promise<number> =>
    Number(
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
  return {
    users: await count('users'),
    workspaces: await count('workspaces'),
    memberships: await count('memberships'),
  };
}

/** CT-IDS ids. */
export const newId: (prefix: IdPrefix) => string = createIdGenerator();

/** A fixed clock for rows the service stamps. */
export const NOW = new Date('2026-10-07T12:00:00.000Z');

/** A user row, for fakes. */
export function userRow(overrides: Partial<User> = {}): User {
  return {
    id: newId('usr'),
    email: 'grace@example.test',
    display_name: 'Grace',
    locale: 'en',
    avatar_slot: null,
    telemetry_opt_in: false,
    status: 'active',
    deletion_requested_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** What a scripted driver answers: rows, an affected-row count, or an error to throw. */
export type Reply = { rows?: Record<string, unknown>[]; affected?: bigint } | Error;

/**
 * A Kysely whose every statement is recorded in `statements` and answered by `reply` (default:
 * no rows). Transactions are recorded as `begin`, `commit` and `rollback`.
 */
export function scriptedDb(reply: (query: CompiledQuery) => Reply = () => ({})): {
  db: Kysely<CoreDatabase>;
  statements: string[];
} {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      const answer = reply(query);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        rows: (answer.rows ?? []) as R[],
        ...(answer.affected === undefined ? {} : { numAffectedRows: answer.affected }),
      });
    },
    streamQuery() {
      throw new Error('scriptedDb does not stream');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => {
      statements.push('begin');
      return Promise.resolve();
    },
    commitTransaction: () => {
      statements.push('commit');
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      statements.push('rollback');
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<CoreDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

/** A unique violation as `pg` reports it. */
export function uniqueViolation(constraint: string): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint,
    },
  );
}
