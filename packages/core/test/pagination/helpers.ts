/**
 * Test helpers for pagination (B025): signing keys made at run time, a fixed now, and a Kysely
 * over a scripted driver that records every compiled query and answers with the rows a test
 * gives it (no Postgres needed for the SQL the helper builds).
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { Secret, type SigningKey } from '../../src/index.js';

/** A signing key with a fresh 32-byte secret. */
export const signingKey = (id: string): SigningKey => ({
  id,
  secret: new Secret(new Uint8Array(randomBytes(32))),
});

/** 2026-10-07 12:00 UTC, in milliseconds. */
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

/** A filter hash and sort a cursor can be bound to. */
export const BINDING = { filterHash: `sha256:${'a'.repeat(64)}`, sort: 'created_at' };

/** A cursor signed with `key` over any `payload` text, as an attacker with the key could make. */
export function signRaw(key: SigningKey, payload: string): string {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signed = `${key.id}.${encoded}`;
  const signature = createHmac('sha256', key.secret.reveal()).update(signed).digest('base64url');
  return `${signed}.${signature}`;
}

/** The table the keyset tests page through. */
export interface ItemsDatabase {
  items: { id: string; created_at: Date; kind: string };
}

/** A Kysely whose compiled queries are kept in `queries` and answered by `rows`. */
export function scriptedDb(rows: (query: CompiledQuery) => Record<string, unknown>[] = () => []): {
  db: Kysely<ItemsDatabase>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return Promise.resolve({ rows: rows(query) as R[] });
    },
    streamQuery() {
      throw new Error('scriptedDb does not stream');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<ItemsDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}
