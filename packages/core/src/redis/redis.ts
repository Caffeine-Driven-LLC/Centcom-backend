/**
 * Redis backend (B009): KeyValue, PubSub and RateLimitStore on ioredis. One connection for
 * commands and, once something subscribes, a second one in subscriber mode. Every key and channel
 * gets the `ct:<env>:` prefix and every key a TTL; a command that fails for want of Redis
 * (refused, lost, over the 2 s command timeout) rejects with a 503 AppError, and callers decide
 * whether to fail open or closed.
 *
 * Owns: connection options (reconnect backoff, command timeout, TLS through rediss://), the
 * namespace, error translation and the subscriber's handler dispatch. Must not: log keys,
 * values, messages or the URL, or let a handler's error end its subscription.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { Redis, type RedisOptions as IORedisOptions } from 'ioredis';
import type { Secret } from '../config/secret.js';
import { AppError } from '../errors/app-error.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import { INCR_LUA, RATE_LIMIT_LUA } from './scripts.js';
import {
  checkConsume,
  checkKey,
  checkTtl,
  checkValue,
  COMMAND_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  KEY_PREFIX_PATTERN,
  resetSeconds,
  type KeyValue,
  type PubSub,
  type RateLimitStore,
  type RedisBackend,
  type Unsubscribe,
} from './types.js';

/** How long to wait for a TCP connection, by default. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Longest pause between reconnect attempts (plus up to 100 ms of jitter). */
export const MAX_RECONNECT_DELAY_MS = 3_000;

/** Settings for `createRedis`. */
export interface RedisConfig {
  /** `redis://` or `rediss://` (TLS) URL, such as `baseConfig().redisUrl`. Never logged. */
  url: Secret<string>;
  /** `ct:<env>:` (see `keyPrefixFor`): every key and channel is written under it. */
  keyPrefix: string;
  /** Milliseconds, for the rate-limit window; default Date.now (tests pass a fake). */
  clock?: () => number;
  /** Default COMMAND_TIMEOUT_MS (2 s). */
  commandTimeoutMs?: number;
  /** Default CONNECT_TIMEOUT_MS (5 s). */
  connectTimeoutMs?: number;
  /** Writes connection warnings and handler failures; never keys, values or messages. */
  logger?: Logger;
  /**
   * Receives `redis_unavailable_total`, `redis_connection_errors_total`, `redis_reconnects_total`
   * and `redis_pubsub_handler_errors_total`.
   */
  metrics?: Metrics;
}

/** The scripts as client methods (ioredis defines them from the `scripts` option). */
interface ScriptCommands {
  ctRateLimit(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    cost: number,
    nonce: string,
  ): Promise<[number, number, number]>;
  ctIncr(key: string, ttlMs: number): Promise<number>;
}

/** A copy of an error with only name, message and code (never options or the URL). */
function sanitized(err: unknown): Error {
  const copy = new Error(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.name !== 'Error') {
    Object.defineProperty(copy, 'name', { value: err.name, writable: true, configurable: true });
  }
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? Object.assign(copy, { code }) : copy;
}

/** Redis answered with an error (WRONGTYPE, a script error): a bug, not an outage. */
const isReplyError = (err: unknown): boolean => err instanceof Error && err.name === 'ReplyError';

/** Creates the Redis backend; it connects at once and reconnects on its own when the link drops. */
export function createRedis(cfg: RedisConfig): RedisBackend {
  if (!KEY_PREFIX_PATTERN.test(cfg.keyPrefix)) {
    throw new TypeError('createRedis: keyPrefix must look like ct:<env>: (see keyPrefixFor)');
  }
  const url = cfg.url.reveal();
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new TypeError('createRedis: url is not a valid URL');
  }
  if (protocol !== 'redis:' && protocol !== 'rediss:') {
    throw new TypeError('createRedis: url must be a redis:// or rediss:// URL');
  }
  const prefix = cfg.keyPrefix;
  const clock = cfg.clock ?? Date.now;
  const metrics = cfg.metrics ?? noopMetrics;
  const options: IORedisOptions = {
    keyPrefix: prefix,
    commandTimeout: cfg.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    connectTimeout: cfg.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    // Commands wait for a reconnect only as long as the command timeout allows.
    maxRetriesPerRequest: 1,
    retryStrategy: (times) =>
      Math.min(100 * 2 ** Math.min(times, 5), MAX_RECONNECT_DELAY_MS) + randomInt(0, 100),
    scripts: {
      ctRateLimit: { lua: RATE_LIMIT_LUA, numberOfKeys: 1 },
      ctIncr: { lua: INCR_LUA, numberOfKeys: 1 },
    },
  };

  /** Logs a connection's trouble once per outage, counts every error, and counts reconnects. */
  const watch = (connection: Redis, role: 'commands' | 'subscriber'): void => {
    let healthy = true;
    let wasReady = false;
    connection.on('error', (err: unknown) => {
      metrics.counter('redis_connection_errors_total').inc();
      if (!healthy) return;
      healthy = false;
      cfg.logger?.warn({ err: sanitized(err), role }, 'redis.connection_error');
    });
    connection.on('ready', () => {
      if (wasReady) {
        metrics.counter('redis_reconnects_total').inc();
        cfg.logger?.info({ role }, 'redis.reconnected');
      }
      wasReady = true;
      healthy = true;
    });
  };

  const client = new Redis(url, options);
  watch(client, 'commands');
  const scripts = client as unknown as ScriptCommands;
  let subscriber: Redis | undefined;
  let closed = false;

  const unavailable = (cause: unknown): AppError => {
    metrics.counter('redis_unavailable_total').inc();
    return new AppError('service_unavailable', { cause: sanitized(cause) });
  };

  /** Runs one command; failures for want of Redis become a 503, answers from Redis stay as they are. */
  const call = async <T>(command: () => Promise<T>): Promise<T> => {
    if (closed) throw unavailable(new Error('the Redis backend is closed'));
    try {
      return await command();
    } catch (err) {
      throw isReplyError(err) ? err : unavailable(err);
    }
  };

  const kv: KeyValue = {
    async get(key) {
      checkKey(key);
      return call(() => client.get(key));
    },
    async set(key, value, opts = {}) {
      checkKey(key);
      checkValue(value);
      const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
      checkTtl(ttlMs);
      await call(() => client.set(key, value, 'PX', ttlMs));
    },
    async setIfAbsent(key, value, ttlMs) {
      checkKey(key);
      checkValue(value);
      checkTtl(ttlMs);
      return (await call(() => client.set(key, value, 'PX', ttlMs, 'NX'))) === 'OK';
    },
    async del(key) {
      checkKey(key);
      return call(() => client.del(key));
    },
    async incr(key, ttlMs) {
      checkKey(key);
      checkTtl(ttlMs);
      return Number(await call(() => scripts.ctIncr(key, ttlMs)));
    },
    async ttl(key) {
      checkKey(key);
      const ms = await call(() => client.pttl(key));
      return ms < 0 ? null : ms;
    },
  };

  /** Handlers by prefixed channel name. */
  const handlers = new Map<string, Set<(message: string) => void>>();

  const deliver = (handler: (message: string) => void, message: string): void => {
    try {
      handler(message);
    } catch (err) {
      // The message (and the error's text, which can quote it) stays out of the log.
      metrics.counter('redis_pubsub_handler_errors_total').inc();
      cfg.logger?.warn(
        { error_type: err instanceof Error ? err.name : typeof err },
        'redis.pubsub.handler_failed',
      );
    }
  };

  /** The subscriber connection, opened on first use. ioredis resubscribes after a reconnect. */
  const subscriberConnection = (): Redis => {
    if (subscriber !== undefined) return subscriber;
    const connection = client.duplicate();
    watch(connection, 'subscriber');
    connection.on('message', (channel: string, message: string) => {
      for (const handler of handlers.get(channel) ?? []) deliver(handler, message);
    });
    subscriber = connection;
    return connection;
  };

  const pubsub: PubSub = {
    async publish(channel, message) {
      checkKey(channel, 'channel');
      checkValue(message, 'message');
      // Channels are not keys, so ioredis does not prefix them: the namespace is added here.
      await call(() => client.publish(prefix + channel, message));
    },
    async subscribe(channel, handler) {
      checkKey(channel, 'channel');
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      const name = prefix + channel;
      const subscription = (message: string): void => handler(message);
      let set = handlers.get(name);
      const first = set === undefined;
      if (set === undefined) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(subscription);
      if (first) {
        try {
          await call(() => subscriberConnection().subscribe(name));
        } catch (err) {
          set.delete(subscription);
          if (set.size === 0) handlers.delete(name);
          throw err;
        }
      }
      let active = true;
      const unsubscribe: Unsubscribe = async () => {
        if (!active) return;
        active = false;
        const current = handlers.get(name);
        current?.delete(subscription);
        if (current === undefined || current.size > 0) return;
        handlers.delete(name);
        // A failure here leaves a server-side subscription whose messages nobody handles.
        await call(() => subscriberConnection().unsubscribe(name)).catch(() => undefined);
      };
      return unsubscribe;
    },
  };

  const rateLimit: RateLimitStore = {
    async consume(key, limit, windowS, cost) {
      const units = checkConsume(key, limit, windowS, cost);
      const now = Math.floor(clock());
      const windowMs = windowS * 1000;
      const nonce = randomBytes(8).toString('hex');
      const [allowed, remaining, oldest] = await call(() =>
        scripts.ctRateLimit(key, now, windowMs, limit, units, nonce),
      );
      return {
        allowed: Number(allowed) === 1,
        limit,
        remaining: Math.max(0, Number(remaining)),
        resetS: resetSeconds(Number(oldest) < 0 ? undefined : Number(oldest), now, windowMs),
      };
    },
  };

  /** QUIT, or drop the connection if Redis cannot be told. */
  const quit = async (connection: Redis | undefined): Promise<void> => {
    if (connection === undefined) return;
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  };

  return {
    kv,
    pubsub,
    rateLimit,
    async ping() {
      await call(() => client.ping());
    },
    async close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      await Promise.all([quit(client), quit(subscriber)]);
    },
  };
}
