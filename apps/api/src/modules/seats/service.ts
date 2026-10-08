/**
 * Seat accounting (B030, CT-ENTITLEMENTS): how many seats a workspace uses. A seat is taken by a
 * membership whose role is in `SEAT_COUNTED_ROLES` (CT-ENTITLEMENTS: `owner`, `admin`, `member`;
 * `guest` and `billing` take none) and reserved by a pending invite for such a role: not accepted,
 * not revoked, not expired, and stopping to count at the instant `expires_at` passes. Invites of a
 * deleted workspace never count.
 *
 * Counts run in one statement on whatever executor they are given: the caller's transaction when a
 * member is being added (so the count and the insert agree), else the pool.
 *
 * Owns: the count. Must not: read plans or Stripe state, or cache a count (it is always live).
 */
import type { Api } from '@centcom/contracts';
import type { AuditDb } from '@centcom/core';
import type { InviteDatabase } from '@centcom/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
} from 'kysely';
import type { Period, UsageReaderPort } from '../entitlements/ports.js';

/**
 * The workspace roles that consume a seat: the one place this is decided (CT-ENTITLEMENTS
 * "Seats"). Pending invites count only for these roles.
 */
export const SEAT_COUNTED_ROLES: readonly Api.Role[] = Object.freeze(['owner', 'admin', 'member']);

/** What runs a seat query: a Kysely instance or transaction (B036's `AuditDb` shape). */
export type SeatDb = AuditDb;

/** A workspace's seats. */
export interface SeatUsage {
  /** Memberships that take a seat. */
  members: number;
  /** Pending invites that reserve one. */
  pending_invites: number;
  /** `members + pending_invites`: what the gate compares with `max_seats`. */
  total: number;
}

/** Compiles the counts. It never connects (DummyDriver): the executor given to `usage` runs them. */
const builder = new Kysely<InviteDatabase>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** The count of `workspaceId`'s seats at `now`, as one statement. */
export function seatUsageQuery(
  workspaceId: string,
  now: Date,
  roles: readonly string[] = SEAT_COUNTED_ROLES,
): CompiledQuery<{ members: string | number; pending_invites: string | number }> {
  const counted = sql.join(roles);
  return sql<{ members: string | number; pending_invites: string | number }>`
    select
      (select count(*) from memberships m
        where m.workspace_id = ${workspaceId} and m.role in (${counted})) as members,
      (select count(*) from invites i
        where i.workspace_id = ${workspaceId}
          and i.role in (${counted})
          and i.accepted_at is null
          and i.revoked_at is null
          and i.expired_at is null
          and i.expires_at > ${now}
          and exists (
            select 1 from workspaces w where w.id = i.workspace_id and w.deleted_at is null
          )) as pending_invites
  `.compile(builder);
}

/** Dependencies of the seat service. */
export interface SeatServiceDeps {
  /** The pool, for counts outside a transaction. */
  db: SeatDb;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
}

/** Counts seats. */
export class SeatService {
  private readonly now: () => number;

  constructor(private readonly deps: SeatServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The workspace's seats now, counted in `trx` when given (else on the pool). */
  async usage(workspaceId: string, trx?: SeatDb): Promise<SeatUsage> {
    const executor = trx ?? this.deps.db;
    const result = await executor.executeQuery(seatUsageQuery(workspaceId, new Date(this.now())));
    const row = result.rows[0];
    const members = Number(row?.members ?? 0);
    const pending = Number(row?.pending_invites ?? 0);
    return { members, pending_invites: pending, total: members + pending };
  }
}

/** The read-only seat summary for billing (B073) and the entitlements object (B069). */
export const getSeatUsage = (seats: SeatService, workspaceId: string): Promise<SeatUsage> =>
  seats.usage(workspaceId);

/**
 * A usage reader for B069 that adds `usage.seats` (seats taken by memberships, CT-ENTITLEMENTS)
 * to what `inner` reports (B075's metered usage; none until then).
 */
export function withSeatUsage(seats: SeatService, inner: UsageReaderPort): UsageReaderPort {
  return {
    async read(workspaceId: string, period: Period | null) {
      const [report, usage] = await Promise.all([
        inner.read(workspaceId, period),
        seats.usage(workspaceId),
      ]);
      return { ...report, usage: { ...report.usage, seats: usage.members } };
    },
  };
}
