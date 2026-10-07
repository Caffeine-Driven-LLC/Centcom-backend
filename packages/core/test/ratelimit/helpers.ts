/**
 * Test helpers for rate limiting (B023): a limiter over B009's in-memory backend on a fake clock,
 * a store and key-value store that fail on demand, metrics counted by name and labels, and
 * principals with real CT-IDS ids (made at run time).
 */
import { newId } from '@centcom/contracts';
import {
  createMemoryRedis,
  createRateLimiter,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  unavailable,
  type KeyValue,
  type LimitDecision,
  type LimitRequest,
  type MetricLabels,
  type Metrics,
  type RateLimitConfig,
  type RateLimiter,
  type RateLimitPrincipal,
  type RateLimitStore,
} from '../../src/index.js';
import { captureLogger, FakeClock } from '../redis/helpers.js';

export { captureLogger, FakeClock };

/** The default configuration, one trusted proxy, unless overridden. */
export const testConfig = (overrides: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  buckets: defaultBuckets,
  trustedHops: 1,
  exempt: DEFAULT_EXEMPT_ROUTES,
  ...overrides,
});

/** A Metrics that counts counters by name and labels. */
export function labelledMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
} {
  const key = (name: string, labels?: MetricLabels): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  const counts = new Map<string, number>();
  return {
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + n),
      }),
      histogram: () => ({ observe: () => undefined }),
    },
    count: (name, labels) => counts.get(key(name, labels)) ?? 0,
  };
}

/** The error a failing store throws, as B009's Redis backend does (its message names the host). */
export const storeDown = (): Error =>
  unavailable(1, 'redis unavailable', { cause: new Error('connect ECONNREFUSED 10.9.8.7:6379') });

/** `inner`, unless `down`: then every call rejects. Counts the calls that reached it. */
export function flakyStore(inner: RateLimitStore): RateLimitStore & {
  down: boolean;
  calls: number;
  failWith: () => Error;
} {
  const store = {
    down: false,
    calls: 0,
    failWith: storeDown,
    consume: (key: string, limit: number, windowS: number, cost?: number) => {
      store.calls += 1;
      if (store.down) return Promise.reject(store.failWith());
      return inner.consume(key, limit, windowS, cost);
    },
  };
  return store;
}

/** `inner`, unless `down`: then every call rejects. */
export function flakyKv(inner: KeyValue): KeyValue & { down: boolean } {
  const fail = (): Promise<never> => Promise.reject(storeDown());
  const kv: KeyValue & { down: boolean } = {
    down: false,
    get: (key) => (kv.down ? fail() : inner.get(key)),
    set: (key, value, opts) => (kv.down ? fail() : inner.set(key, value, opts)),
    setIfAbsent: (key, value, ttlMs) => (kv.down ? fail() : inner.setIfAbsent(key, value, ttlMs)),
    del: (key) => (kv.down ? fail() : inner.del(key)),
    incr: (key, ttlMs) => (kv.down ? fail() : inner.incr(key, ttlMs)),
    ttl: (key) => (kv.down ? fail() : inner.ttl(key)),
  };
  return kv;
}

/** A limiter over an in-memory backend that can be made to fail, with everything it touches. */
export function setup(config: RateLimitConfig = testConfig()): {
  clock: FakeClock;
  store: ReturnType<typeof flakyStore>;
  kv: ReturnType<typeof flakyKv>;
  log: ReturnType<typeof captureLogger>;
  counters: ReturnType<typeof labelledMetrics>;
  limiter: RateLimiter;
} {
  const clock = new FakeClock();
  const backend = createMemoryRedis(clock.read);
  const store = flakyStore(backend.rateLimit);
  const kv = flakyKv(backend.kv);
  const log = captureLogger();
  const counters = labelledMetrics();
  const limiter = createRateLimiter({
    store,
    kv,
    config,
    clock: clock.read,
    logger: log.logger,
    metrics: counters.metrics,
  });
  return { clock, store, kv, log, counters, limiter };
}

/** A user, with a device when asked. */
export const aUser = (opts: { device?: boolean } = {}): RateLimitPrincipal & { kind: 'user' } => ({
  kind: 'user',
  userId: newId('usr'),
  ...(opts.device === true ? { deviceId: newId('dev') } : {}),
});

/** An API key. */
export const anApiKey = (): RateLimitPrincipal => ({ kind: 'api_key', keyId: newId('key') });

/** An anonymous request from `ip` to a default route, with `overrides`. */
export const anonymous = (ip: string, overrides: Partial<LimitRequest> = {}): LimitRequest => ({
  bucket: 'default',
  principal: null,
  ip,
  ...overrides,
});

/** Runs `n` checks one after another. */
export async function checkTimes(
  limiter: RateLimiter,
  n: number,
  request: LimitRequest,
): Promise<LimitDecision[]> {
  const decisions: LimitDecision[] = [];
  for (let i = 0; i < n; i++) decisions.push(await limiter.check(request));
  return decisions;
}

/** How many of `decisions` were allowed. */
export const allowedCount = (decisions: readonly LimitDecision[]): number =>
  decisions.filter((d) => d.allowed).length;
