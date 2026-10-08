/**
 * The entitlements module's vocabulary and ports (B069, CT-ENTITLEMENTS): plan ids, statuses and
 * limit keys as the contract names them, the subscription state billing lanes apply, the usage
 * reader B075 fills in, and the invalidation channel.
 *
 * Owns: these names. Must not: add a limit key (a contract change) or read Stripe objects.
 */
import type { Api } from '@centcom/contracts';
import type { PubSub } from '@centcom/core';

/** A plan id. */
export type PlanId = Api.Entitlements['plan'];
/** A subscription status (CT-ENTITLEMENTS §4). */
export type EntitlementStatus = Api.Entitlements['status'];
/** The limits of a plan: CT-ENTITLEMENTS §2's keys, exactly. */
export type EntitlementLimits = Api.EntLimits;
/** A limit key. */
export type LimitKey = keyof EntitlementLimits;
/** The CT-ENTITLEMENTS object. */
export type Entitlements = Api.Entitlements;

/** The plans, cheapest first. */
export const PLAN_IDS: readonly PlanId[] = Object.freeze(['free', 'pro', 'team']);
/** The statuses. */
export const ENTITLEMENT_STATUSES: readonly EntitlementStatus[] = Object.freeze([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'none',
]);
/** The limit keys, in CT-ENTITLEMENTS §2's order; the response lists them in this order. */
export const LIMIT_KEYS: readonly LimitKey[] = Object.freeze([
  'relay_access',
  'lan_multiplayer',
  'max_seats',
  'max_session_members',
  'max_concurrent_sessions',
  'max_parallel_agents',
  'history_days',
  'hosted_minutes_month',
  'queue_items_month',
  'audit_log_days',
  'webhooks_max',
  'api_keys_max',
]);
/** The keys whose value is a flag; every other key is a count. */
export const FLAG_KEYS: ReadonlySet<LimitKey> = new Set(['relay_access', 'lan_multiplayer']);
/** The counts that may be null (unlimited), as `EntLimits` types them. */
export const NULLABLE_KEYS: ReadonlySet<LimitKey> = new Set([
  'max_seats',
  'hosted_minutes_month',
  'queue_items_month',
]);

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
export const isEntitlementStatus = (value: unknown): value is EntitlementStatus =>
  typeof value === 'string' && (ENTITLEMENT_STATUSES as readonly string[]).includes(value);

/** A billing period. */
export interface Period {
  start: Date;
  end: Date;
}

/**
 * A workspace's subscription as billing sees it (B070's rows, B072's webhooks, B078's dunning):
 * `past_due_since` is required for `past_due`, `addon_seats` counts seats bought on top of the
 * plan (team only).
 */
export interface SubscriptionState {
  plan: PlanId;
  status: EntitlementStatus;
  period: Period | null;
  past_due_since: Date | null;
  addon_seats: number;
}

/** Why a revision was bumped without a state change. */
export type BumpReason = 'usage_warning' | 'plan' | 'admin';

/** Usage and warnings of a workspace's period (B075). */
export interface UsageReport {
  usage: NonNullable<Entitlements['usage']>;
  warnings: NonNullable<Entitlements['warnings']>;
}

/** Reads usage for the entitlements object; B075 provides the real one. */
export interface UsageReaderPort {
  read(workspaceId: string, period: Period | null): Promise<UsageReport>;
}

/** Reports no usage and no warnings: the reader until B075. */
export const emptyUsageReader: UsageReaderPort = Object.freeze({
  read: () => Promise.resolve({ usage: {}, warnings: [] }),
});

/** The Redis channel announcing a new revision: `{workspace, rev}` as JSON. */
export const ENTITLEMENTS_INVALIDATE_CHANNEL = 'entitlements:invalidate';

/** Where invalidations are published (B009 `RedisBackend.pubsub`). */
export type InvalidationPublisher = Pick<PubSub, 'publish'>;
