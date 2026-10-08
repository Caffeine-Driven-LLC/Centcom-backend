/**
 * Entitlements in Postgres (B069): the plan catalog (`plans`, `plan_limits`) and each workspace's
 * entitlement row (`workspace_entitlements`), migration 20260102001500_plans_entitlements.sql.
 *
 * - Reads see live workspaces only; a workspace without a row reads as the free plan with status
 *   `none` at rev 0, the row its first change writes.
 * - `transaction(fn)` gives `fn` the row of one workspace, locked (written first if missing), and
 *   the write that replaces it, in one transaction (B007's `withTransaction`, which retries
 *   serialization failures, so `fn` keeps side effects outside the database out).
 * - `deleteForWorkspace` is the purge hook's: it deletes the row of a deleted workspace only.
 *
 * Owns: the SQL of entitlements. Must not: decide what a state resolves to (resolve.ts does), or
 * return a deleted workspace's row.
 */
import { withTransaction, type EntitlementsDb } from '@centcom/db';
import type { Kysely, Transaction } from 'kysely';
import {
  FLAG_KEYS,
  type EntitlementStatus,
  type LimitKey,
  type Period,
  type PlanId,
} from './ports.js';

/** A workspace's entitlement row. */
export interface StoredEntitlement {
  workspaceId: string;
  plan: PlanId;
  status: EntitlementStatus;
  period: Period | null;
  graceUntil: Date | null;
  addonSeats: number;
  rev: number;
  /** The digest `rev` was issued for; null until first resolved (the free defaults). */
  digest: Buffer | null;
  /** False when the workspace has no row yet: these are the defaults. */
  stored: boolean;
}

/** What a change writes. */
export type EntitlementWrite = Omit<StoredEntitlement, 'workspaceId' | 'stored'>;

/** A plan as its rows give it; a limit missing from the rows is missing here. */
export interface CatalogPlan {
  id: PlanId;
  name: string;
  limits: Partial<Record<LimitKey, boolean | number | null>>;
}

/** The operations of one transaction. */
export interface EntitlementTx {
  /**
   * Locks the row of live workspace `workspaceId`, writing the default row first when it has
   * none; null when there is no live workspace.
   */
  lock(workspaceId: string): Promise<StoredEntitlement | null>;
  /** Replaces the locked row's state, revision and digest. */
  write(workspaceId: string, row: EntitlementWrite): Promise<void>;
}

export interface EntitlementRepository {
  /** Every plan with its limit rows. */
  plans(): Promise<CatalogPlan[]>;
  /** The row of live workspace `workspaceId` (the defaults when it has none); null when none. */
  find(workspaceId: string): Promise<StoredEntitlement | null>;
  transaction<T>(fn: (tx: EntitlementTx) => Promise<T>): Promise<T>;
  /** Deletes the row of deleted workspace `workspaceId`; the count deleted (0 for a live one). */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

type Db = Kysely<EntitlementsDb> | Transaction<EntitlementsDb>;

interface Row {
  workspace_id: string;
  plan_id: PlanId;
  status: EntitlementStatus;
  period_start: Date | null;
  period_end: Date | null;
  grace_until: Date | null;
  addon_seats: number;
  rev: number;
  resolved_digest: Buffer | null;
}

const COLUMNS = [
  'e.workspace_id',
  'e.plan_id',
  'e.status',
  'e.period_start',
  'e.period_end',
  'e.grace_until',
  'e.addon_seats',
  'e.rev',
  'e.resolved_digest',
] as const;

const fromRow = (row: Row): StoredEntitlement => ({
  workspaceId: row.workspace_id,
  plan: row.plan_id,
  status: row.status,
  period:
    row.period_start === null || row.period_end === null
      ? null
      : { start: row.period_start, end: row.period_end },
  graceUntil: row.grace_until,
  addonSeats: row.addon_seats,
  rev: row.rev,
  digest: row.resolved_digest,
  stored: true,
});

/** The defaults of a workspace without a row. */
export const defaultEntitlement = (workspaceId: string): StoredEntitlement => ({
  workspaceId,
  plan: 'free',
  status: 'none',
  period: null,
  graceUntil: null,
  addonSeats: 0,
  rev: 0,
  digest: null,
  stored: false,
});

function operations(trx: Transaction<EntitlementsDb>): EntitlementTx {
  return {
    async lock(workspaceId) {
      await trx
        .insertInto('workspace_entitlements')
        .columns(['workspace_id'])
        .expression(
          trx
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', workspaceId)
            .where('deleted_at', 'is', null),
        )
        .onConflict((oc) => oc.column('workspace_id').doNothing())
        .execute();
      const row = await trx
        .selectFrom('workspace_entitlements as e')
        .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
        .select(COLUMNS)
        .where('e.workspace_id', '=', workspaceId)
        .where('w.deleted_at', 'is', null)
        .forUpdate('e')
        .executeTakeFirst();
      return row === undefined ? null : fromRow(row);
    },
    async write(workspaceId, row) {
      await trx
        .updateTable('workspace_entitlements')
        .set({
          plan_id: row.plan,
          status: row.status,
          period_start: row.period?.start ?? null,
          period_end: row.period?.end ?? null,
          grace_until: row.graceUntil,
          addon_seats: row.addonSeats,
          rev: row.rev,
          resolved_digest: row.digest,
          updated_at: new Date(),
        })
        .where('workspace_id', '=', workspaceId)
        .execute();
    },
  };
}

/** The repository over `db`. */
export function createEntitlementRepository(db: Kysely<EntitlementsDb>): EntitlementRepository {
  const read: Db = db;
  return {
    async plans() {
      const rows = await read
        .selectFrom('plans')
        .leftJoin('plan_limits', 'plan_limits.plan_id', 'plans.id')
        .select([
          'plans.id',
          'plans.name',
          'plan_limits.key',
          'plan_limits.bool_value',
          'plan_limits.int_value',
        ])
        .orderBy('plans.id')
        .execute();
      const plans = new Map<PlanId, CatalogPlan>();
      for (const row of rows) {
        const plan = plans.get(row.id) ?? { id: row.id, name: row.name, limits: {} };
        plans.set(row.id, plan);
        if (row.key !== null) {
          plan.limits[row.key] = FLAG_KEYS.has(row.key) ? row.bool_value : row.int_value;
        }
      }
      return [...plans.values()];
    },
    async find(workspaceId) {
      const row = await read
        .selectFrom('workspaces as w')
        .leftJoin('workspace_entitlements as e', 'e.workspace_id', 'w.id')
        .select(['w.id', ...COLUMNS])
        .where('w.id', '=', workspaceId)
        .where('w.deleted_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) return null;
      if (row.workspace_id === null) return defaultEntitlement(workspaceId);
      return fromRow(row as Row);
    },
    transaction: (fn) => withTransaction(db, (trx) => fn(operations(trx))),
    async deleteForWorkspace(workspaceId) {
      const result = await read
        .deleteFrom('workspace_entitlements')
        .where('workspace_id', '=', workspaceId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('workspaces')
              .select('id')
              .where('id', '=', workspaceId)
              .where('deleted_at', 'is not', null),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
