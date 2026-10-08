/**
 * Plans and entitlements (B069, CT-ENTITLEMENTS, CT-API-BILLING): the resolver from subscription
 * state to limits, the plan seed, the Postgres repository, the service with `rev`, and the ETag of
 * the entitlements object. The routes are `routes/plans/` and `routes/entitlements/`; the purge
 * hook is @centcom/worker's `registerEntitlementsPurgeHook`. B080 adds the cached read side and its
 * checks (`enforcement.ts`; the preHandlers are `plugins/entitlements.ts`).
 */
export {
  CachedEntitlements,
  ENFORCEMENT_DETAILS,
  ENT_RETRY_AFTER_S,
  entitlementCacheEnvSchema,
  entitlementsExpireAt,
  loadEntitlementCacheConfig,
  METERED_KEYS,
  type CachedEntitlementsDeps,
  type CheckResult,
  type EntitlementEnforcer,
} from './enforcement.js';
export { entitlementsEtag, ifNoneMatchHits } from './etag.js';
export {
  emptyUsageReader,
  ENTITLEMENT_STATUSES,
  ENTITLEMENTS_INVALIDATE_CHANNEL,
  FLAG_KEYS,
  isEntitlementStatus,
  isPlanId,
  LIMIT_KEYS,
  NULLABLE_KEYS,
  PLAN_IDS,
  type BumpReason,
  type EntitlementLimits,
  type Entitlements,
  type EntitlementStatus,
  type InvalidationPublisher,
  type LimitKey,
  type Period,
  type PlanId,
  type SubscriptionState,
  type UsageReaderPort,
  type UsageReport,
} from './ports.js';
export {
  createEntitlementRepository,
  defaultEntitlement,
  type CatalogPlan,
  type EntitlementRepository,
  type EntitlementTx,
  type EntitlementWrite,
  type StoredEntitlement,
} from './repository.js';
export {
  ADDON_SEAT_PLANS,
  checkAddonSeats,
  checkLimits,
  checkPeriod,
  EntitlementError,
  GRACE_DAYS,
  GRACE_MS,
  graceUntilFor,
  MAX_ADDON_SEATS,
  resolvedDigest,
  resolveEntitlements,
  type EntitlementErrorCode,
  type PlanCatalog,
  type Resolved,
  type ResolveInput,
} from './resolve.js';
export {
  SEED_PLANS,
  SeedPlansError,
  validateSeedPlans,
  type SeedPlan,
  type SeedPlans,
  type SeedPrice,
} from './seed-plans.js';
export {
  BUMP_REASONS,
  CATALOG_TTL_MS,
  ENTITLEMENT_DETAILS,
  EntitlementService,
  INVALIDATE_ATTEMPTS,
  type EntitlementServiceOptions,
} from './service.js';
