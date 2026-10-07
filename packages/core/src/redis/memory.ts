/**
 * In-memory Redis backend (B009): the same KeyValue, PubSub and RateLimitStore behaviour as the
 * Redis implementation, inside one process, on an injectable clock. Unit tests use it everywhere,
 * and services may use it as a per-process fallback (B023), so its memory is bounded.
 *
 * Owns: TTL expiry by the given clock, in-process pub/sub, the sliding window, the key cap. Must
 * not: share state across processes, keep a key past its TTL, or log values or messages.
 */
import { AppError } from '../errors/app-error.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import {
  checkConsume,
  checkKey,
  checkTtl,
  checkValue,
  DEFAULT_TTL_MS,
  resetSeconds,
  type KeyValue,
  type PubSub,
  type RateLimitResult,
  type RateLimitStore,
  type RedisBackend,
  type SetOptions,
  type Unsubscribe,
} from './types.js';

/** Keys (values plus rate-limit buckets) kept before the oldest are evicted. */
export const DEFAULT_MEMORY_MAX_KEYS = 100_000;

/** Options for `createMemoryRedis`. */
export interface MemoryRedisOptions {
  /** Most keys kept; past it, expired keys are swept, then the oldest are evicted. */
  maxKeys?: number;
  /** Writes `redis.pubsub.handler_failed` warnings (never the message). */
  logger?: Logger;
  /** Receives `redis_pubsub_handler_errors_total` and `redis_memory_evictions_total`. */
  metrics?: Metrics;
}

interface Entry {
  value: string;
  expiresAt: number;
}

const closedError = (): AppError =>
  new AppError('service_unavailable', { cause: new Error('the in-memory backend is closed') });

/**
 * Creates an in-memory backend. `clock` (milliseconds; default Date.now) drives TTLs and the
 * rate-limit window, so tests can move time on.
 */
export function createMemoryRedis(
  clock: () => number = Date.now,
  options: MemoryRedisOptions = {},
): RedisBackend {
  const maxKeys = options.maxKeys ?? DEFAULT_MEMORY_MAX_KEYS;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1)
    throw new RangeError('maxKeys must be a positive integer');
  const metrics = options.metrics ?? noopMetrics;
  const entries = new Map<string, Entry>();
  const buckets = new Map<string, number[]>();
  const channels = new Map<string, Set<(message: string) => void>>();
  let closed = false;

  const open = (): void => {
    if (closed) throw closedError();
  };

  /** A live entry, removing it when it has expired. */
  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > clock()) return entry;
    entries.delete(key);
    return undefined;
  };

  /** Keeps the total number of keys within maxKeys: expired ones first, then the oldest written. */
  const enforceCap = (): void => {
    if (entries.size + buckets.size <= maxKeys) return;
    const now = clock();
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
    const evictions = metrics.counter('redis_memory_evictions_total');
    for (const map of [entries, buckets] as Map<string, unknown>[]) {
      for (const key of map.keys()) {
        if (entries.size + buckets.size <= maxKeys) return;
        map.delete(key);
        evictions.inc();
      }
    }
  };

  const write = (key: string, value: string, ttlMs: number): void => {
    // Re-inserting moves the key to the end of the eviction order.
    entries.delete(key);
    entries.set(key, { value, expiresAt: clock() + ttlMs });
    enforceCap();
  };

  const kv: KeyValue = {
    async get(key) {
      open();
      checkKey(key);
      return live(key)?.value ?? null;
    },
    async set(key, value, opts: SetOptions = {}) {
      open();
      checkKey(key);
      checkValue(value);
      const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
      checkTtl(ttlMs);
      write(key, value, ttlMs);
    },
    async setIfAbsent(key, value, ttlMs) {
      open();
      checkKey(key);
      checkValue(value);
      checkTtl(ttlMs);
      if (live(key) !== undefined) return false;
      write(key, value, ttlMs);
      return true;
    },
    async del(key) {
      open();
      checkKey(key);
      return live(key) !== undefined && entries.delete(key) ? 1 : 0;
    },
    async incr(key, ttlMs) {
      open();
      checkKey(key);
      checkTtl(ttlMs);
      const entry = live(key);
      if (entry === undefined) {
        write(key, '1', ttlMs);
        return 1;
      }
      // Redis refuses INCR on a value that is not a 64-bit integer; so does this.
      if (!/^-?\d{1,19}$/.test(entry.value) || !Number.isSafeInteger(Number(entry.value) + 1)) {
        throw new TypeError('incr: the value is not an integer');
      }
      const next = Number(entry.value) + 1;
      entry.value = String(next);
      return next;
    },
    async ttl(key) {
      open();
      checkKey(key);
      const entry = live(key);
      return entry === undefined ? null : entry.expiresAt - clock();
    },
  };

  // One FIFO for every delivery keeps the order of messages per channel, as Redis does.
  const deliveries: (() => void)[] = [];
  let draining = false;
  const drain = (): void => {
    draining = false;
    for (let next = deliveries.shift(); next !== undefined; next = deliveries.shift()) next();
  };

  const deliver = (handler: (message: string) => void, message: string): void => {
    try {
      handler(message);
    } catch (err) {
      // The message (and the error's text, which can quote it) stays out of the log.
      metrics.counter('redis_pubsub_handler_errors_total').inc();
      options.logger?.warn(
        { error_type: err instanceof Error ? err.name : typeof err },
        'redis.pubsub.handler_failed',
      );
    }
  };

  const pubsub: PubSub = {
    async publish(channel, message) {
      open();
      checkKey(channel, 'channel');
      checkValue(message, 'message');
      for (const handler of channels.get(channel) ?? []) {
        deliveries.push(() => deliver(handler, message));
      }
      if (!draining && deliveries.length > 0) {
        draining = true;
        queueMicrotask(drain);
      }
    },
    async subscribe(channel, handler) {
      open();
      checkKey(channel, 'channel');
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      // A wrapper per call, so the same function subscribed twice is two subscriptions.
      const subscription = (message: string): void => handler(message);
      let handlers = channels.get(channel);
      if (handlers === undefined) {
        handlers = new Set();
        channels.set(channel, handlers);
      }
      handlers.add(subscription);
      const unsubscribe: Unsubscribe = async () => {
        const current = channels.get(channel);
        current?.delete(subscription);
        if (current?.size === 0) channels.delete(channel);
      };
      return unsubscribe;
    },
  };

  const rateLimit: RateLimitStore = {
    async consume(key, limit, windowS, cost) {
      open();
      const units = checkConsume(key, limit, windowS, cost);
      const now = clock();
      const windowMs = windowS * 1000;
      const counted = (buckets.get(key) ?? []).filter((at) => at > now - windowMs);
      const allowed = counted.length + units <= limit;
      if (allowed) for (let i = 0; i < units; i++) counted.push(now);
      if (counted.length === 0) buckets.delete(key);
      else {
        buckets.delete(key);
        buckets.set(key, counted);
        enforceCap();
      }
      const result: RateLimitResult = {
        allowed,
        limit,
        remaining: limit - counted.length,
        resetS: resetSeconds(
          counted.length === 0 ? undefined : Math.min(...counted),
          now,
          windowMs,
        ),
      };
      return result;
    },
  };

  return {
    kv,
    pubsub,
    rateLimit,
    async ping() {
      open();
    },
    async close() {
      closed = true;
      entries.clear();
      buckets.clear();
      channels.clear();
      deliveries.length = 0;
    },
  };
}
