# Redis (B009)

Short-lived shared state behind three small interfaces, with two implementations that behave the
same: `createMemoryRedis` (one process, injectable clock; unit tests and per-process fallbacks)
and `createRedis` (ioredis, production). Redis is a cache and a coordination tool here, never the
source of truth for money, membership or entitlements.

```ts
import { baseConfig, createRedis, keyPrefixFor } from '@centcom/core';

const config = baseConfig(); // in apps/*/src/main.ts
const redis = createRedis({
  url: config.redisUrl,
  keyPrefix: keyPrefixFor(config.nodeEnv),
  logger,
  metrics,
});

await redis.kv.setIfAbsent(`jti:${jti}`, '1', ttlMs); // single-use token ids, idempotency keys
const { allowed, remaining, resetS } = await redis.rateLimit.consume(`ip:${ip}`, 30, 60);
const stop = await redis.pubsub.subscribe('ent:inv', (message) => invalidate(message));
```

## Interfaces

| Interface        | Methods                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeyValue`       | `get`, `set(k, v, {ttlMs?})`, `setIfAbsent(k, v, ttlMs)` (atomic), `del`, `incr(k, ttlMs)` (a new key gets the TTL; an existing one keeps its own), `ttl` |
| `PubSub`         | `publish(channel, message)`, `subscribe(channel, handler)` → `unsubscribe()`. At most once, in order per channel                                          |
| `RateLimitStore` | `consume(key, limit, windowS, cost?)` → `{allowed, limit, remaining, resetS}`: a sliding window in one atomic step                                        |
| `RedisBackend`   | `{kv, pubsub, rateLimit, ping(), close()}`, from `createMemoryRedis(clock?, options?)` or `createRedis(config)`                                           |

## Rules

- **Every key expires.** `set` without `ttlMs` uses `DEFAULT_TTL_MS` (24 h); TTLs run from 1 ms
  to `MAX_TTL_MS` (31 days). Rate-limit buckets expire one window after their last call.
- **Every key and channel is namespaced** `ct:<env>:` (`keyPrefixFor(nodeEnv)`), so environments
  sharing a Redis never meet. ioredis prefixes keys; the backend prefixes channels itself.
- **Limits:** keys and channel names up to 512 characters; values and messages up to 1 MiB;
  `limit` up to 10 000 calls; windows up to 24 h. Bad arguments throw `TypeError`/`RangeError`
  before anything is sent.
- **Atomic where it matters.** `setIfAbsent` is `SET … NX PX`; `incr` and `consume` are Lua
  scripts (`scripts.ts`) run with EVALSHA, never get-then-set. The scripts take `now` from the
  caller's clock, so every instance and the in-memory backend agree and tests can fake time.
- **Nothing is logged** but connection trouble and handler failures: never keys, values,
  messages or the URL.

## Failure modes

- **Redis down or slow:** every call rejects with a 503 `AppError('service_unavailable')` within
  the 2 s command timeout (`COMMAND_TIMEOUT_MS`), never hanging. This layer does not decide what
  happens next: callers choose to fail open or closed (B023 falls back to an in-memory limiter).
- **Reconnects:** ioredis reconnects with backoff (100 ms doubling to 3 s, plus jitter) and
  resubscribes; messages published while a subscriber is away are lost (pub/sub keeps nothing).
  The first error of an outage is logged as `redis.connection_error`, the recovery as
  `redis.reconnected`.
- **Errors from Redis itself** (`WRONGTYPE`, `incr` on a word) pass through as they are: a bug,
  not an outage.
- **Script evicted (NOSCRIPT):** ioredis loads it again and retries once.
- **A handler that throws:** caught, counted and logged as `redis.pubsub.handler_failed` with the
  error's type only (its text can quote the message); the subscription goes on.
- **In-memory backend:** bounded by `maxKeys` (default 100 000): expired keys are swept first,
  then the oldest written are evicted (`redis_memory_evictions_total`).

**Metrics:** `redis_unavailable_total`, `redis_connection_errors_total`, `redis_reconnects_total`,
`redis_pubsub_handler_errors_total`, `redis_memory_evictions_total`.

## Tests

`packages/core/test/redis/` runs one contract suite against both backends: the in-memory one
always, a real Redis 7 when `REDIS_URL` is set (CI's `integration` job), each under its own
`ct:t…:` prefix.

- **`kv.contract.test.ts`:** values, TTLs, `setIfAbsent` with 100 concurrent callers, `del`,
  `incr`, limits; on Redis, every key carries the prefix and a TTL
- **`ratelimit.contract.test.ts`:** 30 in a window and a 31st denied, a full window empties it,
  sliding, costs, 50 concurrent callers; on Redis, the bucket TTL and NOSCRIPT recovery
- **`pubsub.contract.test.ts`:** order, channels, several handlers, unsubscribe, a throwing
  handler; on Redis, the channel namespace and reconnecting after the connection is killed
- **`failure.test.ts`:** a Redis that never answers (the 2 s timeout), a refused connection,
  settings, closed backends, the in-memory key cap, errors from Redis itself
