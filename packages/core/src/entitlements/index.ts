/**
 * Entitlements for every service (B080): the read-through cache the API and the relay share, and
 * its invalidation listener. Also published as `@centcom/core/entitlements`.
 */
export {
  DEFAULT_ENT_CACHE_MAX_ENTRIES,
  EntitlementCache,
  listenForInvalidations,
  MAX_ENT_CACHE_TTL_MS,
  parseInvalidation,
  type EntitlementCacheOptions,
  type InvalidationMessage,
} from './cache.js';
