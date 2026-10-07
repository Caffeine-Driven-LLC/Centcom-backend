/**
 * Test helpers for the audit emitter (B036): a fake database that keeps the rows of the inserts it
 * is given and can fail or stall on demand, ids made at run time (no ULID literals for the secret
 * scan to flag), a valid event, and a Postgres-shaped error.
 */
import { newId } from '@centcom/contracts';
import type { CompiledQuery, QueryResult } from 'kysely';
import type { AuditDb, AuditEvent } from '../../src/index.js';

export { captureLogger } from '../redis/helpers.js';
export { recordingMetrics } from '../log/helpers.js';

/** Ids for the sample event. */
export const IDS = {
  workspace: newId('wsp'),
  user: newId('usr'),
  member: newId('usr'),
  membership: newId('mem'),
  request: newId('req'),
  device: newId('dev'),
  session: newId('ses'),
} as const;

/** A valid event: a member made admin. */
export function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    workspaceId: IDS.workspace,
    actor: { type: 'user', id: IDS.user },
    action: 'member.role_change',
    target: { type: 'membership', id: IDS.membership },
    outcome: 'success',
    requestId: IDS.request,
    meta: { user_id: IDS.member, from_role: 'member', to_role: 'admin' },
    ...overrides,
  };
}

/** An error as `pg` reports one: `code` is the SQLSTATE. */
export const pgError = (code: string, message = 'database error'): Error =>
  Object.assign(new Error(message), { code });

/** The rows of an `insert into "audit_events"`, column by column. */
export function rowsOf(query: CompiledQuery): Record<string, unknown>[] {
  const match = /^insert into "audit_events" \(([^)]+)\) values /.exec(query.sql);
  if (match === null) throw new Error(`not an audit insert: ${query.sql}`);
  const columns = (match[1] ?? '').split(', ').map((c) => c.replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < query.parameters.length; at += columns.length) {
    rows.push(Object.fromEntries(columns.map((c, i) => [c, query.parameters[at + i]])));
  }
  return rows;
}

/** A database (or, with `isTransaction`, a transaction) that keeps what it is asked to insert. */
export interface FakeDb extends AuditDb {
  /** Every query, in order, including failed ones. */
  readonly queries: CompiledQuery[];
  /** The rows of the inserts that succeeded, in order. */
  readonly rows: Record<string, unknown>[];
  /** When set, decides per insert: an error to throw, or undefined to succeed. */
  failWith: ((rows: Record<string, unknown>[]) => unknown) | undefined;
  /** When set, inserts wait for it to resolve. */
  gate: Promise<void> | undefined;
}

export function fakeDb(isTransaction = false): FakeDb {
  const db: FakeDb = {
    isTransaction,
    queries: [],
    rows: [],
    failWith: undefined,
    gate: undefined,
    async executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> {
      db.queries.push(query);
      if (db.gate !== undefined) await db.gate;
      const rows = rowsOf(query);
      const err: unknown = db.failWith?.(rows);
      if (err !== undefined) throw err;
      db.rows.push(...rows);
      return { rows: [] };
    },
  };
  return db;
}

/** A promise and the function that settles it. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
