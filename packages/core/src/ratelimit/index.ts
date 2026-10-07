/**
 * Rate limiting (B023, CT-PAGE): the buckets and their keys, client addresses behind trusted
 * proxies, and the policy (shared counters, per-process fallback, abuse block). The Fastify plugin
 * that applies it lives in `apps/api/src/plugins/rate-limit.ts`. See README.md in this package.
 */
export {
  BUCKET_NAMES,
  bucketKey,
  checkRateLimitConfig,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  FALLBACK_MULTIPLIER,
  MAX_BUCKET_LIMIT,
  MAX_BUCKET_WINDOW_S,
  MIN_BUCKET_WINDOW_S,
  rateLimitConfig,
  rateLimitEnvSchema,
  ROUTE_BUCKETS,
  type BucketKey,
  type BucketLimit,
  type BucketName,
  type Buckets,
  type RateLimitConfig,
  type RateLimitPrincipal,
  type RouteBucket,
} from './buckets.js';
export {
  ipBucket,
  MAX_TRUSTED_HOPS,
  normalizeIp,
  resolveClientIp,
  UNKNOWN_IP,
  type ClientIpSource,
} from './client-ip.js';
export {
  ABUSE_BLOCK_S,
  ABUSE_STRIKES,
  ABUSE_WINDOW_S,
  createRateLimiter,
  RATE_LIMITED_DETAIL,
  STORE_RETRY_MS,
  STORE_WARNING_INTERVAL_MS,
  type LimitDecision,
  type LimitRequest,
  type RateLimiter,
  type RateLimiterOptions,
} from './policy.js';
