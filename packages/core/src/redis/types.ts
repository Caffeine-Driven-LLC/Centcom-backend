/**
 * Redis abstraction (B009): the interfaces services use for short-lived shared state (key-value
 * with TTLs, pub/sub, rate-limit counters), the limits both implementations enforce, and their
 * argument checks. `createMemoryRedis` (tests, single-process fallbacks) and `createRedis`
 * (production) implement them identically.
 *
 * Owns: the interfaces, the limits and the argument rules. Must not: be the source of truth for
 * money, membership or entitlements (a cache only), or allow a key without a TTL.
 */

/** Options for `KeyValue.set`. */
export interface SetOptions {
  /** Lifetime in milliseconds; default DEFAULT_TTL_MS. Every key expires. */
  ttlMs?: number;
}

/** Strings under keys, each with a TTL. Keys are namespaced by the backend (`ct:<env>:`). */
export interface KeyValue {
  /** The value, or null when the key is missing or expired. */
  get(key: string): Promise<string | null>;
  /** Stores `value`, replacing any value and TTL. */
  set(key: string, value: string, opts?: SetOptions): Promise<void>;
  /** Stores `value` only if the key is absent: true if stored. Atomic (idempotency, single-use ids). */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Removes the key; 1 if it existed, else 0. */
  del(key: string): Promise<number>;
  /** Adds 1 and returns the new value; a new key starts at 1 and gets `ttlMs`, an existing one keeps its TTL. */
  incr(key: string, ttlMs: number): Promise<number>;
  /** Milliseconds until the key expires, or null when it is missing. */
  ttl(key: string): Promise<number | null>;
}

/** Stops a subscription; calling it again does nothing. */
export type Unsubscribe = () => Promise<void>;

/** Fire-and-forget messages between processes. Delivery is at most once, in order per channel. */
export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  /**
   * Calls `handler` for every message on `channel` until the returned function is called. A
   * handler that throws is logged (without the message) and keeps its subscription.
   */
  subscribe(channel: string, handler: (message: string) => void): Promise<Unsubscribe>;
}

/** The outcome of one `consume` call, for the CT-PAGE `RateLimit-*` headers. */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Calls left in the current window after this one (0 when denied). */
  remaining: number;
  /** Whole seconds until a slot frees up (at least 1). */
  resetS: number;
}

/** Sliding-window rate limiting: one atomic operation per call, never get-then-set. */
export interface RateLimitStore {
  /**
   * Counts `cost` calls (default 1) against `key` if the last `windowS` seconds hold at most
   * `limit - cost` others; otherwise counts nothing and denies.
   */
  consume(key: string, limit: number, windowS: number, cost?: number): Promise<RateLimitResult>;
}

/** What `createMemoryRedis` and `createRedis` return. */
export interface RedisBackend {
  kv: KeyValue;
  pubsub: PubSub;
  rateLimit: RateLimitStore;
  /** Resolves when the backend answers; rejects with a 503 AppError otherwise. */
  ping(): Promise<void>;
  /** Ends every connection; later calls reject with a 503 AppError. */
  close(): Promise<void>;
}

/** TTL of `set` without `ttlMs`. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest TTL accepted. */
export const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;
/** Longest key or channel name, in characters (before the namespace prefix). */
export const MAX_KEY_LENGTH = 512;
/** Largest value or message, in UTF-8 bytes. */
export const MAX_VALUE_BYTES = 1024 * 1024;
/** Largest `limit` of a rate-limit bucket (each counted call is kept for the window). */
export const MAX_RATE_LIMIT = 10_000;
/** Longest rate-limit window, in seconds. */
export const MAX_WINDOW_S = 24 * 60 * 60;
/** A Redis command that takes longer is abandoned with a 503. */
export const COMMAND_TIMEOUT_MS = 2_000;
/** The namespace every key and channel gets: `ct:<env>:`. */
export const KEY_PREFIX_PATTERN = /^ct:[a-z0-9-]{1,32}:$/;

/** The key prefix for an environment: `ct:production:`, `ct:test:`, ... */
export function keyPrefixFor(env: string): string {
  const prefix = `ct:${env}:`;
  if (!KEY_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('keyPrefixFor: env must be 1-32 characters of a-z, 0-9 and -');
  }
  return prefix;
}

/** Throws a TypeError for a key or channel name that is empty, too long or not a string. */
export function checkKey(key: unknown, what = 'key'): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(`${what} must be a string of 1 to ${MAX_KEY_LENGTH} characters`);
  }
}

/** Throws a RangeError for a value or message over MAX_VALUE_BYTES (or a TypeError for a non-string). */
export function checkValue(value: unknown, what = 'value'): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new RangeError(`${what} is larger than ${MAX_VALUE_BYTES} bytes`);
  }
}

/** Throws a RangeError for a TTL that is not a whole number of milliseconds in 1..MAX_TTL_MS. */
export function checkTtl(ttlMs: unknown): asserts ttlMs is number {
  if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) < 1 || (ttlMs as number) > MAX_TTL_MS) {
    throw new RangeError(`ttlMs must be a whole number of milliseconds from 1 to ${MAX_TTL_MS}`);
  }
}

/** Checks consume's arguments; returns the cost (default 1). */
export function checkConsume(
  key: unknown,
  limit: unknown,
  windowS: unknown,
  cost: unknown = 1,
): number {
  checkKey(key);
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RATE_LIMIT) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_RATE_LIMIT}`);
  }
  if (
    !Number.isSafeInteger(windowS) ||
    (windowS as number) < 1 ||
    (windowS as number) > MAX_WINDOW_S
  ) {
    throw new RangeError(`windowS must be a whole number from 1 to ${MAX_WINDOW_S}`);
  }
  if (!Number.isSafeInteger(cost) || (cost as number) < 1 || (cost as number) > (limit as number)) {
    throw new RangeError('cost must be a whole number from 1 to limit');
  }
  return cost as number;
}

/** `resetS` for a window whose oldest counted call is `oldestMs` (or none): at least 1 second. */
export function resetSeconds(
  oldestMs: number | undefined,
  nowMs: number,
  windowMs: number,
): number {
  const left = oldestMs === undefined ? windowMs : oldestMs + windowMs - nowMs;
  return Math.max(1, Math.ceil(left / 1000));
}
