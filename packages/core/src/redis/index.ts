/**
 * Redis (B009): KeyValue, PubSub and RateLimitStore with two implementations that behave the same,
 * `createMemoryRedis` (one process, injectable clock) and `createRedis` (ioredis). See README.md
 * in this directory.
 */
export {
  COMMAND_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  KEY_PREFIX_PATTERN,
  keyPrefixFor,
  MAX_KEY_LENGTH,
  MAX_RATE_LIMIT,
  MAX_TTL_MS,
  MAX_VALUE_BYTES,
  MAX_WINDOW_S,
  type KeyValue,
  type PubSub,
  type RateLimitResult,
  type RateLimitStore,
  type RedisBackend,
  type SetOptions,
  type Unsubscribe,
} from './types.js';
export { createMemoryRedis, DEFAULT_MEMORY_MAX_KEYS, type MemoryRedisOptions } from './memory.js';
export {
  CONNECT_TIMEOUT_MS,
  createRedis,
  MAX_RECONNECT_DELAY_MS,
  type RedisConfig,
} from './redis.js';
