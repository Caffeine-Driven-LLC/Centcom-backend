/**
 * Rate-limit plugin (B023, CT-PAGE): counts every request against its bucket before body parsing
 * and any handler, and answers `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on
 * every response it counted (200, 404, 429 alike). Past the limit, the answer is 429
 * `rate_limited` with `Retry-After` and `retry_after_s`.
 *
 * Routes choose a bucket with `config: { rateLimit: { bucket, cost? } }`: `default` (the caller's:
 * anonymous per address, user or API key per id), `auth` (per address) or `usage` (per device).
 * Routes under `/v1/auth/` default to `auth`. Route templates in `config.exempt` (the health
 * probes) are never limited. The policy, its fallback and the abuse block are `createRateLimiter`
 * in `@centcom/core`.
 *
 * Owns: the hook, the headers and the check of route configs. Must not: key on the raw URL, let
 * an uncounted request reach parsing or a handler, or show one caller another's counter.
 */
import {
  createRateLimiter,
  RATE_LIMITED_DETAIL,
  resolveClientIp,
  ROUTE_BUCKETS,
  tooManyRequests,
  type KeyValue,
  type Logger,
  type Metrics,
  type RateLimitConfig,
  type RateLimiter,
  type RateLimitPrincipal,
  type RateLimitStore,
  type RouteBucket,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route's rate-limit bucket (B023) and what one request costs (default 1). */
    rateLimit?: { bucket: RouteBucket; cost?: number };
  }
}

/** Options for `rateLimitPlugin`. */
export interface RateLimitPluginOptions {
  /** The shared counters (B009 `RedisBackend.rateLimit`). */
  store: RateLimitStore;
  config: RateLimitConfig;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Where abuse blocks are shared (B009 `RedisBackend.kv`); default: this process only. */
  kv?: KeyValue;
  /**
   * The caller, from the auth plugin's principal; null when anonymous. It may throw the 401 of a
   * failed credential: the request then counts as anonymous before that error goes out. Default:
   * everyone is anonymous (counted per address, stricter than any principal's bucket).
   */
  principal?: (request: FastifyRequest) => RateLimitPrincipal | null;
  logger?: Logger;
  metrics?: Metrics;
}

/** Routes under this prefix count in the `auth` bucket unless they declare another. */
export const AUTH_ROUTE_PREFIX = '/v1/auth/';

/** Throws a TypeError for a route's `rateLimit` config the limiter cannot honour. */
function checkRouteConfig(value: unknown, limiter: RateLimiter, url: string): void {
  const config = value as { bucket?: unknown; cost?: unknown } | null;
  const bucket = typeof config === 'object' && config !== null ? config.bucket : undefined;
  if (!ROUTE_BUCKETS.includes(bucket as RouteBucket)) {
    throw new TypeError(
      `rateLimitPlugin: route ${url} needs config.rateLimit.bucket ${ROUTE_BUCKETS.join(', ')}`,
    );
  }
  const cost = config?.cost ?? 1;
  const max = limiter.maxCost(bucket as RouteBucket);
  if (!Number.isSafeInteger(cost) || (cost as number) < 1 || (cost as number) > max) {
    throw new TypeError(
      `rateLimitPlugin: route ${url} has a cost that is not a whole number from 1 to ${max}`,
    );
  }
}

const plugin: FastifyPluginAsync<RateLimitPluginOptions> = async (app, options) => {
  const { config } = options;
  const limiter = createRateLimiter({
    store: options.store,
    config,
    ...(options.kv === undefined ? {} : { kv: options.kv }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  const exempt = new Set(config.exempt);
  const principalOf = options.principal ?? (() => null);

  // A route that asks for something the limiter cannot do fails at startup, not per request.
  app.addHook('onRoute', (route) => {
    const declared: unknown = route.config?.rateLimit;
    if (declared !== undefined) checkRouteConfig(declared, limiter, route.url);
  });

  app.addHook('onRequest', async (request, reply) => {
    // The route template, never the URL: `/v1/x/1` and `/v1/x/2?y` are the same route. Unmatched
    // URLs (404, 405) have none and count in the caller's bucket.
    const route = request.routeOptions.url;
    if (route !== undefined && exempt.has(route)) return;
    const declared = request.routeOptions.config.rateLimit;
    const bucket = declared?.bucket ?? (route?.startsWith(AUTH_ROUTE_PREFIX) ? 'auth' : 'default');
    // A credential that fails (the principal function throws its 401) counts as anonymous before
    // its error goes out, so bad credentials go no faster than anonymous requests.
    let principal: RateLimitPrincipal | null = null;
    let refusal: { error: unknown } | undefined;
    try {
      principal = principalOf(request);
    } catch (error) {
      refusal = { error };
    }
    const decision = await limiter.check({
      bucket,
      principal,
      ip: resolveClientIp(request, config.trustedHops),
      cost: declared?.cost ?? 1,
    });
    void reply
      .header('ratelimit-limit', String(decision.limit))
      .header('ratelimit-remaining', String(decision.remaining))
      .header('ratelimit-reset', String(decision.resetS));
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterS, RATE_LIMITED_DETAIL);
    if (refusal !== undefined) throw refusal.error;
  });
};

/**
 * Applies to the whole instance (like the error handler). Register it after the request context
 * and error handler plugins and the auth plugin (whose principal it reads), before any route.
 */
export const rateLimitPlugin: FastifyPluginAsync<RateLimitPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-rate-limit',
});
