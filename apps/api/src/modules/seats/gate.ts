/**
 * The seat gate (B030, B029's `SeatGate` port, the Fastify decorator `seatGate`): runs in the
 * transaction that adds a member (an invite created or accepted) and refuses the add when the
 * workspace has no free seat.
 *
 * 1. Read `limits.max_seats` (CT-ENTITLEMENTS) through the entitlements reader. A reader that
 *    fails is a 503 (retryable): the gate fails closed, never unlimited.
 * 2. Take `pg_advisory_xact_lock(hashtext(workspace_id))` in that transaction, waiting at most
 *    5 s (`lock_timeout`, restored afterwards); a longer wait is a 503 with `Retry-After`.
 * 3. Count seats in the same transaction (`SeatService.usage`); `total >= max_seats` is 403
 *    `seat_limit_reached`. `null` never refuses, `0` always does. Nobody is removed when a
 *    downgrade leaves usage above the limit: only new adds are blocked.
 *
 * Every refusal is counted in `seat_gate_rejections_total{reason}`.
 *
 * Owns: the decision. Must not: decide from plan names or Stripe state, release the lock before
 * the transaction ends, or put other members' data in an error.
 */
import {
  AppError,
  isAppError,
  noopMetrics,
  unavailable,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type { EntitlementService } from '../entitlements/service.js';
import type { SeatGate } from '../invites/ports.js';
import type { SeatDb, SeatService } from './service.js';

/** The longest wait for another add to the same workspace. */
export const SEAT_LOCK_TIMEOUT_MS = 5_000;
/** `Retry-After` of a refused wait. */
export const SEAT_LOCK_RETRY_AFTER_S = 1;

/** Where the seat limit comes from (B069's entitlements, B080's cache later). */
export interface SeatLimitReader {
  /** `limits.max_seats`: a count, or null for unlimited. Rejects when it cannot be read. */
  maxSeats(workspaceId: string): Promise<number | null>;
}

/** The limit from B069's `EntitlementService`. */
export function seatLimitsFrom(entitlements: Pick<EntitlementService, 'get'>): SeatLimitReader {
  return {
    async maxSeats(workspaceId) {
      const current = await entitlements.get(workspaceId);
      if (current === null) {
        throw new AppError('entitlement_required', {
          detail: 'The workspace has no plan to add members under.',
        });
      }
      return current.limits.max_seats;
    },
  };
}

/** Dependencies of the gate. */
export interface SeatGateDeps {
  seats: Pick<SeatService, 'usage'>;
  limits: SeatLimitReader;
  metrics?: Metrics;
  logger?: Logger;
}

/** The details of the gate's refusals (GUIDELINES §3.4). */
export const SEAT_DETAILS = Object.freeze({
  full: (limit: number) =>
    limit === 0
      ? 'This workspace’s plan includes no seats.'
      : `This workspace’s plan includes ${limit} seat${limit === 1 ? '' : 's'}, and none is free.`,
  busy: 'Another member is being added to this workspace; try again in a moment.',
} as const);

/** Compiles the lock statements; the caller's transaction runs them. */
const builder = new Kysely<object>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** Postgres `lock_not_available` (a `lock_timeout`) and `query_canceled` (a `statement_timeout`). */
const WAIT_ERRORS: ReadonlySet<string> = new Set(['55P03', '57014']);
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/** Takes the workspace's seat lock in `trx`, waiting at most SEAT_LOCK_TIMEOUT_MS. */
export async function lockWorkspaceSeats(trx: SeatDb, workspaceId: string): Promise<void> {
  const previous = await trx.executeQuery(
    sql<{ value: string }>`select current_setting('lock_timeout') as value`.compile(builder),
  );
  await trx.executeQuery(
    sql`select set_config('lock_timeout', ${`${SEAT_LOCK_TIMEOUT_MS}ms`}, true)`.compile(builder),
  );
  await trx.executeQuery(
    sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`.compile(builder),
  );
  // The transaction goes on with its own lock_timeout; the lock is held until it ends.
  const value = previous.rows[0]?.value ?? '0';
  await trx.executeQuery(sql`select set_config('lock_timeout', ${value}, true)`.compile(builder));
}

/** The gate. */
export function createSeatGate(deps: SeatGateDeps): SeatGate {
  const metrics = deps.metrics ?? noopMetrics;
  const reject = (reason: string): void =>
    metrics.counter('seat_gate_rejections_total', { reason }).inc();

  return {
    async assertCanAdd(trx, workspaceId) {
      let limit: number | null;
      try {
        limit = await deps.limits.maxSeats(workspaceId);
      } catch (err) {
        if (isAppError(err) && err.code === 'entitlement_required') {
          reject('no_entitlements');
          throw err;
        }
        reject('entitlements_unavailable');
        deps.logger?.warn({ err, workspace_id: workspaceId }, 'seats.entitlements_unavailable');
        throw unavailable(undefined, undefined, { cause: new Error('entitlements unavailable') });
      }

      try {
        await lockWorkspaceSeats(trx, workspaceId);
      } catch (err) {
        if (WAIT_ERRORS.has(String(codeOf(err))) || isConnectionError(err)) {
          reject('lock_timeout');
          throw unavailable(SEAT_LOCK_RETRY_AFTER_S, SEAT_DETAILS.busy, {
            cause: new Error('seat lock not acquired'),
          });
        }
        throw err;
      }

      if (limit === null) return;
      const usage = await deps.seats.usage(workspaceId, trx);
      if (usage.total >= limit) {
        reject('limit');
        throw new AppError('seat_limit_reached', { detail: SEAT_DETAILS.full(limit) });
      }
    },
  };
}

/** Puts the gate on the instance as `seatGate`; register it before the invite routes (B029). */
export const seatGatePlugin: FastifyPluginAsync<{ gate: SeatGate }> = Object.assign(
  async (app: Parameters<FastifyPluginAsync>[0], opts: { gate: SeatGate }) => {
    app.decorate('seatGate', opts.gate);
  },
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'centcom-seat-gate',
  },
);
