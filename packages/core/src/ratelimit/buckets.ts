/**
 * Rate-limit buckets (B023, CT-PAGE): the five default limits, their `RATELIMIT_*` overrides, and
 * the bucket and store key a request counts under: a user by `usr_` id from any address, an API
 * key by `key_` id, usage ingest by `dev_` id, everyone else by client address.
 *
 * Owns: the limits, the env keys and the key shapes. Must not: build a key from the URL or from
 * anything the client wrote (ids come from the authenticated principal, addresses from
 * `resolveClientIp`).
 */
import { isId, type IdPrefix } from '@centcom/contracts';
import { z } from 'zod';
import type { BaseConfig } from '../config/base.js';
import { deepFreeze, defineConfig, envInt, type Env } from '../config/define.js';
import { MAX_RATE_LIMIT } from '../redis/types.js';
import { ipBucket, MAX_TRUSTED_HOPS } from './client-ip.js';

/** One bucket: at most `limit` units in any `windowS` seconds. */
export interface BucketLimit {
  readonly limit: number;
  readonly windowS: number;
}

/** The buckets of CT-PAGE. */
export const BUCKET_NAMES = ['anonymous', 'user', 'apiKey', 'auth', 'usage'] as const;
/** A bucket's name. */
export type BucketName = (typeof BUCKET_NAMES)[number];
/** Every bucket's limit. */
export type Buckets = Readonly<Record<BucketName, BucketLimit>>;

/** CT-PAGE's defaults: anonymous 30/min/IP, user 600/min, API key 1200/min, auth 20/min/IP, usage 60/min/device. */
export const defaultBuckets: Buckets = deepFreeze({
  anonymous: { limit: 30, windowS: 60 },
  user: { limit: 600, windowS: 60 },
  apiKey: { limit: 1200, windowS: 60 },
  auth: { limit: 20, windowS: 60 },
  usage: { limit: 60, windowS: 60 },
});

/** How much the per-process fallback multiplies a general bucket's limit; the auth bucket stays at 1x. */
export const FALLBACK_MULTIPLIER = 2;
/** The largest bucket limit: twice it must still fit B009's MAX_RATE_LIMIT. */
export const MAX_BUCKET_LIMIT = MAX_RATE_LIMIT / FALLBACK_MULTIPLIER;
/** The window range, in seconds. */
export const MIN_BUCKET_WINDOW_S = 10;
export const MAX_BUCKET_WINDOW_S = 3600;

/** The bucket a route declares: `default` is the caller's own (anonymous, user or API key). */
export const ROUTE_BUCKETS = ['default', 'auth', 'usage'] as const;
/** A route's bucket. */
export type RouteBucket = (typeof ROUTE_BUCKETS)[number];

/** Route templates that are never limited: the health probes. */
export const DEFAULT_EXEMPT_ROUTES: readonly string[] = Object.freeze(['/healthz', '/readyz']);

/** Who is calling, as rate limiting sees it; anonymous callers are null. */
export type RateLimitPrincipal =
  | { readonly kind: 'user'; readonly userId: string; readonly deviceId?: string }
  | { readonly kind: 'api_key'; readonly keyId: string };

/** Everything the rate limiter needs to know. */
export interface RateLimitConfig {
  readonly buckets: Buckets;
  /** Proxies whose `X-Forwarded-For` is trusted (TRUSTED_PROXY_HOPS). */
  readonly trustedHops: number;
  /** Route templates that are never limited. */
  readonly exempt: readonly string[];
}

/** The rate-limit environment keys (rendered into docs/config.md and .env.example). */
export const rateLimitEnvSchema = z.object({
  RATELIMIT_ANONYMOUS_LIMIT: envInt({ min: 1, max: MAX_BUCKET_LIMIT })
    .default(defaultBuckets.anonymous.limit)
    .meta({
      description: 'Requests per window from one client address without credentials.',
      example: '30',
    }),
  RATELIMIT_USER_LIMIT: envInt({ min: 1, max: MAX_BUCKET_LIMIT })
    .default(defaultBuckets.user.limit)
    .meta({ description: 'Requests per window from one user, from any address.', example: '600' }),
  RATELIMIT_API_KEY_LIMIT: envInt({ min: 1, max: MAX_BUCKET_LIMIT })
    .default(defaultBuckets.apiKey.limit)
    .meta({ description: 'Requests per window with one API key.', example: '1200' }),
  RATELIMIT_AUTH_LIMIT: envInt({ min: 1, max: MAX_BUCKET_LIMIT })
    .default(defaultBuckets.auth.limit)
    .meta({
      description:
        'Requests per window from one client address to the auth endpoints (/v1/auth/*).',
      example: '20',
    }),
  RATELIMIT_USAGE_LIMIT: envInt({ min: 1, max: MAX_BUCKET_LIMIT })
    .default(defaultBuckets.usage.limit)
    .meta({ description: 'Usage-ingest requests per window from one device.', example: '60' }),
  RATELIMIT_WINDOW_S: envInt({ min: MIN_BUCKET_WINDOW_S, max: MAX_BUCKET_WINDOW_S })
    .default(60)
    .meta({ description: "Length of every bucket's sliding window, in seconds.", example: '60' }),
});

/**
 * The rate-limit configuration: limits from the environment (default: the process environment,
 * through the config loader) and the trusted proxy hops from the base configuration.
 */
export function rateLimitConfig(
  base: Pick<BaseConfig, 'trustedProxyHops'>,
  env?: Env,
): RateLimitConfig {
  const v = defineConfig(rateLimitEnvSchema, env);
  const windowS = v.RATELIMIT_WINDOW_S;
  return deepFreeze({
    buckets: {
      anonymous: { limit: v.RATELIMIT_ANONYMOUS_LIMIT, windowS },
      user: { limit: v.RATELIMIT_USER_LIMIT, windowS },
      apiKey: { limit: v.RATELIMIT_API_KEY_LIMIT, windowS },
      auth: { limit: v.RATELIMIT_AUTH_LIMIT, windowS },
      usage: { limit: v.RATELIMIT_USAGE_LIMIT, windowS },
    },
    trustedHops: base.trustedProxyHops,
    exempt: DEFAULT_EXEMPT_ROUTES,
  });
}

/** Throws a TypeError or RangeError for a configuration the limiter cannot run with. */
export function checkRateLimitConfig(config: RateLimitConfig): void {
  for (const name of BUCKET_NAMES) {
    const bucket = config.buckets[name] as BucketLimit | undefined;
    const { limit, windowS } = bucket ?? { limit: NaN, windowS: NaN };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BUCKET_LIMIT) {
      throw new RangeError(
        `rate limit ${name}: limit must be a whole number from 1 to ${MAX_BUCKET_LIMIT}`,
      );
    }
    if (!Number.isSafeInteger(windowS) || windowS < 1 || windowS > MAX_BUCKET_WINDOW_S) {
      throw new RangeError(
        `rate limit ${name}: windowS must be a whole number from 1 to ${MAX_BUCKET_WINDOW_S}`,
      );
    }
  }
  const hops = config.trustedHops;
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > MAX_TRUSTED_HOPS) {
    throw new RangeError(
      `rate limit: trustedHops must be a whole number from 0 to ${MAX_TRUSTED_HOPS}`,
    );
  }
  if (
    !Array.isArray(config.exempt) ||
    !config.exempt.every((r) => typeof r === 'string' && r.startsWith('/'))
  ) {
    throw new TypeError('rate limit: exempt must list route templates starting with /');
  }
}

/** Where a request is counted. */
export interface BucketKey {
  readonly bucket: BucketName;
  /** The store key: `rl:<bucket>:<subject>`. */
  readonly key: string;
  /** The address bucket when the subject is an address; the abuse block applies to these. */
  readonly ipKey?: string;
}

/** A principal's id, checked: a malformed one is a bug in whoever built the principal. */
function idOf(prefix: IdPrefix, value: string): string {
  if (!isId(prefix, value))
    throw new TypeError(`rate limit: the principal's ${prefix} id is malformed`);
  return value;
}

/** Counted by address in `bucket`. */
const byAddress = (bucket: BucketName, ip: string, subject = ''): BucketKey => {
  const ipKey = ipBucket(ip);
  return { bucket, key: `rl:${bucket}:${subject}${ipKey}`, ipKey };
};

/**
 * The bucket and key of a request to a route with bucket `route`, from `principal` (null when
 * anonymous) at address `ip`:
 *
 * - `auth`: the address, whoever calls;
 * - `usage`: the device, else the user or API key, else the address;
 * - `default`: the user or API key, else the address (the anonymous bucket).
 */
export function bucketKey(
  route: RouteBucket,
  principal: RateLimitPrincipal | null,
  ip: string,
): BucketKey {
  if (route === 'auth') return byAddress('auth', ip);
  const own =
    principal === null
      ? undefined
      : principal.kind === 'user'
        ? idOf('usr', principal.userId)
        : idOf('key', principal.keyId);
  if (route === 'usage') {
    if (principal?.kind === 'user' && principal.deviceId !== undefined) {
      return { bucket: 'usage', key: `rl:usage:${idOf('dev', principal.deviceId)}` };
    }
    return own === undefined
      ? byAddress('usage', ip, 'ip:')
      : { bucket: 'usage', key: `rl:usage:${own}` };
  }
  if (principal === null || own === undefined) return byAddress('anonymous', ip);
  return principal.kind === 'user'
    ? { bucket: 'user', key: `rl:user:${own}` }
    : { bucket: 'apiKey', key: `rl:apiKey:${own}` };
}
