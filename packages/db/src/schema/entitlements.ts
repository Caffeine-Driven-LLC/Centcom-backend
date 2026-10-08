/**
 * Table types of plans and entitlements (B069, migration 20260102001500_plans_entitlements.sql):
 * the plans, one row per plan and CT-ENTITLEMENTS limit key, and each workspace's entitlement
 * state. Written by the API's entitlements repository; enums, flags, counts and timestamps only.
 */
import type { Api } from '@centcom/contracts';
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, NullableTimestamp, UpdatedAt } from './core.js';

/** A plan id (CT-ENTITLEMENTS). */
export type PlanId = Api.Entitlements['plan'];
/** A subscription status (CT-ENTITLEMENTS §4). */
export type EntitlementStatus = Api.Entitlements['status'];
/** A CT-ENTITLEMENTS limit key. */
export type LimitKey = keyof Api.EntLimits;

export interface PlansTable {
  id: ColumnType<PlanId, PlanId, never>;
  name: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PlanLimitsTable {
  plan_id: ColumnType<PlanId, PlanId, never>;
  key: ColumnType<LimitKey, LimitKey, never>;
  /** Set for `relay_access` and `lan_multiplayer` only. */
  bool_value: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** A count; null for the flags, and for an unlimited count. */
  int_value: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface WorkspaceEntitlementsTable {
  workspace_id: ColumnType<string, string, never>;
  plan_id: ColumnType<PlanId, PlanId | undefined, PlanId>;
  status: ColumnType<EntitlementStatus, EntitlementStatus | undefined, EntitlementStatus>;
  period_start: NullableTimestamp;
  period_end: NullableTimestamp;
  /** When a past-due subscription's grace ends; set exactly when `status` is `past_due`. */
  grace_until: NullableTimestamp;
  addon_seats: ColumnType<number, number | undefined, number>;
  /** CT-AUTH's `ent` claim: moves on when the resolved plan, status or limits change. */
  rev: ColumnType<number, number | undefined, number>;
  /** sha256 of the resolved {plan, status, limits} `rev` was issued for; null: never resolved. */
  resolved_digest: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The plan and entitlement tables. */
export interface EntitlementsDatabase {
  plans: PlansTable;
  plan_limits: PlanLimitsTable;
  workspace_entitlements: WorkspaceEntitlementsTable;
}

/** What the entitlements repository reads and writes: the core tables and these. */
export type EntitlementsDb = CoreDatabase & EntitlementsDatabase;
