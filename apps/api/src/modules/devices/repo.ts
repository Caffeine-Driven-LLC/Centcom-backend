/**
 * Device storage for the devices service (B020): the `DeviceStore` port the service depends on, and
 * `deviceStoreFromDb`, which runs the device repository (`@centcom/db`) and turns an unreachable
 * database or a statement cancelled by `statement_timeout` (a slow peer lookup, say) into a 503 with
 * no connection details, never a 500.
 *
 * Owns: the port and its error mapping. Must not: hold SQL (the repository does).
 */
import { unavailable } from '@centcom/core';
import {
  createDeviceRepo,
  isConnectionError,
  type CoreDatabase,
  type DeviceRepo,
} from '@centcom/db';
import type { Kysely } from 'kysely';

/** What the devices service needs from storage (the repository's operations). */
export type DeviceStore = DeviceRepo;

/** Postgres `query_canceled`: what `statement_timeout` raises. */
const QUERY_CANCELED = '57014';

/** True for an outage or a timed-out statement: worth a retry, so a 503. */
export function isUnavailable(err: unknown): boolean {
  return isConnectionError(err) || (err as { code?: unknown } | null)?.code === QUERY_CANCELED;
}

/** Runs one storage step; an outage becomes a 503 whose cause holds no details. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isUnavailable(err)) throw err;
    throw unavailable(undefined, undefined, { cause: new Error('database unavailable') });
  }
}

/** The store over Postgres. */
export function deviceStoreFromDb(db: Kysely<CoreDatabase>): DeviceStore {
  const repo = createDeviceRepo(db);
  return {
    insert: (device) => guarded(() => repo.insert(device)),
    findById: (id) => guarded(() => repo.findById(id)),
    listForUser: (userId, params) => guarded(() => repo.listForUser(userId, params)),
    markRevoked: (id, userId, at) => guarded(() => repo.markRevoked(id, userId, at)),
    touch: (id, at, minIntervalMs) => guarded(() => repo.touch(id, at, minIntervalMs)),
    shareSession: (userA, userB) => guarded(() => repo.shareSession(userA, userB)),
  };
}
