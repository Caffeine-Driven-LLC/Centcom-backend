/**
 * What seat changes (B073) need from elsewhere, and two adapters:
 *
 * - `SeatAccountingPort.seatsInUse(workspaceId, db?)`: B030's members plus pending invites
 *   (`seatAccountingFrom(seats)` over B030's `SeatService.usage`), read on the locked connection.
 * - `SeatStripe`: B070's gateway calls a seat change makes: read the subscription, preview an
 *   invoice, update its items.
 * - `SeatLock`: serialises a workspace's seat change with B030's invite gate. `createSeatLock(db)`
 *   takes the same advisory lock B030's gate takes (`hashtext(workspace_id)`), but as a session
 *   lock on one pooled connection outside any transaction, so it can be held across a Stripe call
 *   (Postgres cuts a transaction left idle for 15 s). Each try borrows a connection and gives it
 *   back when the lock is taken by someone else, so waiters hold no connection while they wait.
 *   It waits at most SEAT_LOCK_WAIT_MS, then answers 503 with `Retry-After: 1` (as B030 does); a
 *   database that cannot be reached is a 503 too. The lock goes with the connection if the
 *   process dies.
 *
 * Owns: the interfaces and the lock. Must not: count seats itself (B030 does).
 */
import { unavailable, type AuditDb } from '@centcom/core';
import { sql, type Kysely } from 'kysely';
import type { SeatService as SeatUsageService } from '../../seats/service.js';
import type { StripeGateway } from '../stripe/gateway.js';

/** Members plus pending invites (B030). */
export interface SeatAccountingPort {
  /** Seats in use; on `db` (the locked connection) when given. Fails rather than guess. */
  seatsInUse(workspaceId: string, db?: AuditDb): Promise<number>;
}

/** B070's gateway, as seat changes use it. */
export type SeatStripe = Pick<
  StripeGateway,
  'retrieveSubscription' | 'updateSubscriptionItems' | 'previewInvoice'
>;

/** A workspace's seat lock. */
export interface SeatLock {
  /** Runs `fn` holding the workspace's lock, on the connection that holds it. */
  withWorkspaceLock<T>(workspaceId: string, fn: (db: AuditDb) => Promise<T>): Promise<T>;
}

/** How long a seat change waits for the workspace's lock. */
export const SEAT_LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

/** The user-facing detail of a lock that stayed taken. */
export const SEAT_LOCK_DETAIL =
  'Another change to this workspace is in progress. Try again shortly.';

/** B030's usage as `seatsInUse`: members plus pending invites. */
export const seatAccountingFrom = (seats: Pick<SeatUsageService, 'usage'>): SeatAccountingPort => ({
  seatsInUse: async (workspaceId, db) => (await seats.usage(workspaceId, db)).total,
});

/** Releases the lock; if that fails, every session lock of the connection (none other is taken). */
async function unlock<DB>(conn: Kysely<DB>, workspaceId: string): Promise<void> {
  try {
    await sql`select pg_advisory_unlock(hashtext(${workspaceId}))`.execute(conn);
  } catch {
    // A broken connection takes its locks with it; a live one must not go back to the pool holding
    // one, or every later change of this workspace (and B030's invites) would wait on it.
    await sql`select pg_advisory_unlock_all()`.execute(conn).catch(() => undefined);
  }
}

/** The session advisory lock on Postgres (see the module comment). */
export function createSeatLock<DB>(
  database: Kysely<DB>,
  options: { clock?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): SeatLock {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return {
    async withWorkspaceLock<T>(workspaceId: string, fn: (db: AuditDb) => Promise<T>) {
      const deadline = clock() + SEAT_LOCK_WAIT_MS;
      for (;;) {
        let running = false;
        let attempt: { locked: false } | { locked: true; value: T };
        try {
          attempt = await database.connection().execute(async (conn) => {
            const taken = await sql<{
              locked: boolean;
            }>`select pg_try_advisory_lock(hashtext(${workspaceId})) as locked`.execute(conn);
            if (taken.rows[0]?.locked !== true) return { locked: false as const };
            running = true;
            try {
              return { locked: true as const, value: await fn(conn as unknown as AuditDb) };
            } finally {
              await unlock(conn, workspaceId);
            }
          });
        } catch (err) {
          if (running) throw err;
          // The pool or the lock statement failed (the error's kind only: its text can name the
          // database host).
          throw unavailable(1, SEAT_LOCK_DETAIL, {
            cause: new Error(`seat lock ${err instanceof Error ? err.name : 'failure'}`),
          });
        }
        if (attempt.locked) return attempt.value;
        if (clock() >= deadline) throw unavailable(1, SEAT_LOCK_DETAIL);
        await sleep(LOCK_POLL_MS);
      }
    },
  };
}
