/**
 * The rate-limit policy (B023): counts a request against its bucket in the shared store (B009's
 * Redis `RateLimitStore`), falls back to a per-process limiter while the store fails (general
 * buckets at twice their limit, the auth bucket at its own), and blocks an address for 15 minutes
 * once it has overrun the auth bucket 5 times in 10 minutes.
 *
 * Owns: the decision for one request, the fallback and the abuse block. Must not: let a request
 * through uncounted, fail over without `ratelimit_store_errors_total` and a warning, or put an
 * address or id in a metric label.
 */
import { isAppError } from '../errors/app-error.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import { createMemoryRedis } from '../redis/memory.js';
import type { KeyValue, RateLimitResult, RateLimitStore } from '../redis/types.js';
import {
  bucketKey,
  checkRateLimitConfig,
  FALLBACK_MULTIPLIER,
  type BucketName,
  type RateLimitConfig,
  type RateLimitPrincipal,
  type RouteBucket,
} from './buckets.js';

/** Denials of the auth bucket that make an address a suspect... */
export const ABUSE_STRIKES = 5;
/** ...within this many seconds... */
export const ABUSE_WINDOW_S = 10 * 60;
/** ...block it for this many seconds (anonymous, auth and address-keyed usage requests). */
export const ABUSE_BLOCK_S = 15 * 60;
/** After a store failure, the fallback answers alone for this long before the store is tried again. */
export const STORE_RETRY_MS = 5_000;
/** At most one `ratelimit.store_unavailable` warning per this many milliseconds. */
export const STORE_WARNING_INTERVAL_MS = 60_000;
/** The detail of every 429, whatever the bucket (one shape for all, nothing about the counter). */
export const RATE_LIMITED_DETAIL =
  'Too many requests. Try again after the number of seconds in Retry-After.';

/** One request to decide on. */
export interface LimitRequest {
  /** The route's bucket. */
  bucket: RouteBucket;
  /** The caller, null when anonymous. */
  principal: RateLimitPrincipal | null;
  /** The client address (`resolveClientIp`). */
  ip: string;
  /** Units the request costs; default 1. */
  cost?: number;
}

/** What every decision reports, for the `RateLimit-*` headers. */
interface DecisionBase {
  bucket: BucketName;
  limit: number;
  /** Units left in the window (0 when blocked). */
  remaining: number;
  /** Whole seconds until a unit frees up (or the block ends); at least 1. */
  resetS: number;
  /** True when the per-process fallback decided because the store failed. */
  degraded: boolean;
  /** True when denied because the address is blocked. */
  blocked: boolean;
}

/** The decision: allowed, or denied with the seconds to send as `Retry-After`. */
export type LimitDecision =
  | (DecisionBase & { allowed: true; retryAfterS?: undefined })
  | (DecisionBase & { allowed: false; retryAfterS: number });

/** Options for `createRateLimiter`. */
export interface RateLimiterOptions {
  /** The shared counters (B009 `RedisBackend.rateLimit`). */
  store: RateLimitStore;
  /** Where blocks are shared (B009 `RedisBackend.kv`); default: this process only. */
  kv?: KeyValue;
  config: RateLimitConfig;
  /** Milliseconds; drives the fallback's windows, blocks and retry timing. Default Date.now. */
  clock?: () => number;
  /** Writes `ratelimit.store_unavailable`, `ratelimit.store_recovered` and `ratelimit.ip_blocked`. */
  logger?: Logger;
  /** Receives `ratelimit_store_errors_total`, `ratelimit_denied_total{bucket}` and `ratelimit_blocks_total`. */
  metrics?: Metrics;
}

/** Decides requests. */
export interface RateLimiter {
  /** Counts the request (unless its address is blocked) and decides. */
  check(request: LimitRequest): Promise<LimitDecision>;
  /** The largest cost a route with this bucket may declare (the bucket's smallest limit). */
  maxCost(bucket: RouteBucket): number;
}

/** A store error's kind for the log line, never its message (which can name hosts). */
const failureKind = (err: unknown): string => (isAppError(err) ? err.code : 'error');

/** A rate limiter over `store`, with a per-process fallback. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { store, config, logger } = options;
  checkRateLimitConfig(config);
  const clock = options.clock ?? Date.now;
  const metrics = options.metrics ?? noopMetrics;
  const local = createMemoryRedis(clock, { metrics });
  const kv = options.kv ?? local.kv;
  const storeErrors = metrics.counter('ratelimit_store_errors_total');
  const blocks = metrics.counter('ratelimit_blocks_total');

  /**
   * Runs calls on one shared store: `shared()` while it works, else `fallback()`. A failure is
   * counted and sends the next STORE_RETRY_MS of calls to the fallback alone, so an outage costs
   * one slow call per period and recovery is noticed within one. The counters and the blocks each
   * get one, so each recovers on its own.
   */
  function breaker(name: 'counters' | 'blocks') {
    let retryAt = Number.NEGATIVE_INFINITY;
    let failing = false;
    let warnedAt = Number.NEGATIVE_INFINITY;
    return async <T>(
      shared: () => Promise<T>,
      fallback: () => Promise<T>,
    ): Promise<{ value: T; degraded: boolean }> => {
      if (clock() < retryAt) return { value: await fallback(), degraded: true };
      try {
        const value = await shared();
        if (failing) {
          failing = false;
          logger?.info({ store: name }, 'ratelimit.store_recovered');
        }
        return { value, degraded: false };
      } catch (err) {
        storeErrors.inc();
        failing = true;
        const now = clock();
        retryAt = now + STORE_RETRY_MS;
        if (now - warnedAt >= STORE_WARNING_INTERVAL_MS) {
          warnedAt = now;
          logger?.warn(
            { store: name, reason: failureKind(err), retry_in_ms: STORE_RETRY_MS },
            'ratelimit.store_unavailable',
          );
        }
        return { value: await fallback(), degraded: true };
      }
    };
  }
  const counters = breaker('counters');
  const blockList = breaker('blocks');

  const consume = (
    key: string,
    limit: number,
    fallbackLimit: number,
    windowS: number,
    cost: number,
  ): Promise<{ value: RateLimitResult; degraded: boolean }> =>
    counters(
      () => store.consume(key, limit, windowS, cost),
      () => local.rateLimit.consume(key, fallbackLimit, windowS, cost),
    );

  /** Milliseconds the address stays blocked (0 when it is not), and whether the fallback said so. */
  async function blockedFor(ipKey: string): Promise<{ ms: number; degraded: boolean }> {
    const key = `rl:block:${ipKey}`;
    const { value, degraded } = await blockList(
      () => kv.ttl(key),
      () => local.kv.ttl(key),
    );
    return { ms: value ?? 0, degraded };
  }

  /** Records one overrun of the auth bucket; the ABUSE_STRIKES-th in ABUSE_WINDOW_S blocks the address. */
  async function strike(ipKey: string): Promise<void> {
    const { value: strikes } = await consume(
      `rl:strikes:${ipKey}`,
      ABUSE_STRIKES,
      ABUSE_STRIKES,
      ABUSE_WINDOW_S,
      1,
    );
    if (strikes.allowed && strikes.remaining > 0) return;
    const key = `rl:block:${ipKey}`;
    const ttlMs = ABUSE_BLOCK_S * 1000;
    // A burst can overrun several times at once; the block starts, and is reported, once.
    const { value: started } = await blockList(
      () => kv.setIfAbsent(key, '1', ttlMs),
      () => local.kv.setIfAbsent(key, '1', ttlMs),
    );
    if (!started) return;
    blocks.inc();
    logger?.warn({ client_ip: ipKey, block_s: ABUSE_BLOCK_S }, 'ratelimit.ip_blocked');
  }

  return {
    maxCost(bucket) {
      if (bucket === 'auth') return config.buckets.auth.limit;
      if (bucket === 'usage') return config.buckets.usage.limit;
      const { anonymous, user, apiKey } = config.buckets;
      return Math.min(anonymous.limit, user.limit, apiKey.limit);
    },

    async check(request) {
      const cost = request.cost ?? 1;
      const target = bucketKey(request.bucket, request.principal, request.ip);
      const { limit, windowS } = config.buckets[target.bucket];
      if (target.ipKey !== undefined) {
        const blocked = await blockedFor(target.ipKey);
        if (blocked.ms > 0) {
          const seconds = Math.max(1, Math.ceil(blocked.ms / 1000));
          metrics.counter('ratelimit_denied_total', { bucket: target.bucket }).inc();
          return {
            allowed: false,
            bucket: target.bucket,
            limit,
            remaining: 0,
            resetS: seconds,
            retryAfterS: seconds,
            degraded: blocked.degraded,
            blocked: true,
          };
        }
      }
      // The auth bucket never loosens: it guards credentials.
      const fallbackLimit = target.bucket === 'auth' ? limit : limit * FALLBACK_MULTIPLIER;
      const { value: result, degraded } = await consume(
        target.key,
        limit,
        fallbackLimit,
        windowS,
        cost,
      );
      if (!result.allowed) {
        metrics.counter('ratelimit_denied_total', { bucket: target.bucket }).inc();
        if (target.bucket === 'auth' && target.ipKey !== undefined) await strike(target.ipKey);
      }
      const decided = {
        bucket: target.bucket,
        limit: result.limit,
        remaining: result.remaining,
        resetS: result.resetS,
        degraded,
        blocked: false,
      };
      return result.allowed
        ? { ...decided, allowed: true }
        : { ...decided, allowed: false, retryAfterS: result.resetS };
    },
  };
}
