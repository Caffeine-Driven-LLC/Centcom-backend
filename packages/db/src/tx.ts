/**
 * Transactions (B007): `withTransaction(db, fn)` runs `fn` in one transaction, committed when it
 * resolves and rolled back when it throws, and runs it again when Postgres reports a
 * serialization failure (SQLSTATE 40001), at most MAX_SERIALIZATION_RETRIES times, after a short
 * jittered pause.
 *
 * Owns: the retry policy and the nesting rule. Must not: retry any other error, or let a
 * transaction be opened inside another (it would use a second connection and break atomicity).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Kysely, Transaction } from 'kysely';

/** Transaction isolation levels. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Options for `withTransaction`. */
export interface TransactionOptions {
  /** Default: the server's (`read committed`). */
  isolation?: IsolationLevel;
}

/** Runs after the first attempt when the transaction keeps hitting serialization failures. */
export const MAX_SERIALIZATION_RETRIES = 3;
/** SQLSTATE `serialization_failure`. */
export const SERIALIZATION_FAILURE = '40001';
/** Upper bound of the pause before retry n (0-based): 20 ms, 40 ms, 80 ms. */
const pauseMs = (retry: number): number => randomInt(5, 20 * 2 ** retry + 1);

/** Set while `fn` runs; `open` turns false when the transaction ends, for work `fn` left behind. */
const inTransaction = new AsyncLocalStorage<{ open: boolean }>();

/** True if `err` is a Postgres serialization failure (SQLSTATE 40001). */
export function isSerializationFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === SERIALIZATION_FAILURE;
}

/**
 * Runs `fn` in a transaction and returns what it returns. A serialization failure (from `fn`'s
 * queries or the commit) rolls back and runs `fn` again, up to 3 more times; then, and for any
 * other error, the error is rethrown after the rollback. `fn` may therefore run more than once:
 * keep side effects outside the database out of it.
 *
 * Throws a TypeError when called with a transaction, or from inside another `withTransaction`:
 * pass the transaction you have to the code that needs it instead.
 */
export async function withTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  if (db.isTransaction || inTransaction.getStore()?.open === true) {
    throw new TypeError(
      'withTransaction cannot be nested: pass the open transaction to the code that needs it',
    );
  }
  for (let retry = 0; ; retry++) {
    const marker = { open: true };
    try {
      const builder =
        opts.isolation === undefined
          ? db.transaction()
          : db.transaction().setIsolationLevel(opts.isolation);
      return await builder.execute((trx) => inTransaction.run(marker, () => fn(trx)));
    } catch (err) {
      if (!isSerializationFailure(err) || retry >= MAX_SERIALIZATION_RETRIES) throw err;
    } finally {
      marker.open = false;
    }
    await sleep(pauseMs(retry));
  }
}
