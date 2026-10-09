/**
 * The `quota:state:{wsp}` hash on Redis (B076): the implementation of the API's `QuotaStateCache`
 * (apps/api `modules/billing/quota/state-cache.ts`) that B080 and the relay read.
 *
 * - `write`: in one MULTI, DEL then HSET of every limit's level and PEXPIREAT an hour after the
 *   period ends, so readers never see a mix of two writes.
 * - `fill`: the same, in one Lua script, only if the key does not exist (a rebuild from SQL never
 *   replaces a newer evaluation's hash).
 * - `read`: HGETALL; fields other than `ok`, `warn` or `reached` are left out; an empty hash is
 *   null.
 * - The client keeps B009's connection rules (`createQuotaStateRedisClient`): every key under the
 *   deployment's `ct:<env>:` prefix, commands abandoned after 2 s, reconnects with backoff and
 *   jitter, connection trouble logged by kind only. B009's backend has no hash commands and caps
 *   TTLs at 31 days (a yearly period's hash lives longer), so the module has its own connection,
 *   as the relay's sequence store does (B041).
 *
 * Owns: the commands. Must not: store anything but the levels, or log keys or the URL.
 */
import { randomInt } from 'node:crypto';
import {
  COMMAND_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  KEY_PREFIX_PATTERN,
  type Logger,
  type Secret,
} from '@centcom/core';
import { Redis, type RedisOptions } from 'ioredis';

/** The hash of a workspace (as the API's `quotaStateKey`). */
export const quotaStateRedisKey = (workspaceId: string): string => `quota:state:${workspaceId}`;

const LIMITS = ['hosted_minutes_month', 'queue_items_month'] as const;
const LEVELS: ReadonlySet<string> = new Set(['ok', 'warn', 'reached']);

/** A level of each metered limit. */
export type QuotaStateFields = Record<(typeof LIMITS)[number], 'ok' | 'warn' | 'reached'>;

/** The API's `QuotaStateCache`, as this module implements it. */
export interface RedisQuotaStateCache {
  write(workspaceId: string, levels: QuotaStateFields, expiresAt: Date): Promise<void>;
  fill(workspaceId: string, levels: QuotaStateFields, expiresAt: Date): Promise<boolean>;
  read(workspaceId: string): Promise<Partial<QuotaStateFields> | null>;
  drop(workspaceId: string): Promise<void>;
}

/** KEYS[1] the hash; ARGV the expiry (ms) then field, value pairs. 1 when written, 0 when it existed. */
const FILL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1
`;

/** The hash on `redis` (see the module comment). */
export function createRedisQuotaStateCache(
  redis: Pick<Redis, 'multi' | 'hgetall' | 'del' | 'eval'>,
): RedisQuotaStateCache {
  return {
    async write(workspaceId, levels, expiresAt) {
      const key = quotaStateRedisKey(workspaceId);
      const fields: Record<string, string> = {};
      for (const limit of LIMITS) fields[limit] = levels[limit];
      const results = await redis
        .multi()
        .del(key)
        .hset(key, fields)
        .pexpireat(key, expiresAt.getTime())
        .exec();
      const failed = results?.find(([err]) => err !== null)?.[0];
      if (results === null || failed !== undefined) {
        throw failed ?? new Error('quota state write discarded');
      }
    },
    async fill(workspaceId, levels, expiresAt) {
      const args: string[] = [String(expiresAt.getTime())];
      for (const limit of LIMITS) args.push(limit, levels[limit]);
      const written = await redis.eval(FILL_SCRIPT, 1, quotaStateRedisKey(workspaceId), ...args);
      return written === 1;
    },
    async read(workspaceId) {
      const fields = await redis.hgetall(quotaStateRedisKey(workspaceId));
      const levels: Partial<QuotaStateFields> = {};
      for (const limit of LIMITS) {
        const value = fields[limit];
        if (value !== undefined && LEVELS.has(value)) {
          levels[limit] = value as QuotaStateFields[typeof limit];
        }
      }
      return Object.keys(levels).length === 0 ? null : levels;
    },
    async drop(workspaceId) {
      await redis.del(quotaStateRedisKey(workspaceId));
    },
  };
}

/** Options of the hash's connection. */
export interface QuotaStateRedisClientOptions {
  url: Secret<string>;
  /** `ct:<env>:` (B009's `keyPrefixFor`), the same prefix the relay reads under. */
  keyPrefix: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Connection trouble only, never keys or values. */
  logger?: Logger;
}

/** The hash's connection, with B009's connection rules; it connects on its first command. */
export function createQuotaStateRedisClient(options: QuotaStateRedisClientOptions): Redis {
  if (!KEY_PREFIX_PATTERN.test(options.keyPrefix)) {
    throw new TypeError('createQuotaStateRedisClient: keyPrefix must look like ct:<env>:');
  }
  const ioOptions: RedisOptions = {
    keyPrefix: options.keyPrefix,
    lazyConnect: true,
    commandTimeout: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    connectTimeout: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(100 * 2 ** Math.min(times, 5), 5_000) + randomInt(0, 100),
  };
  const client = new Redis(options.url.reveal(), ioOptions);
  let healthy = true;
  client.on('error', (err: unknown) => {
    if (!healthy) return;
    healthy = false;
    options.logger?.warn(
      { error: err instanceof Error ? err.name : typeof err },
      'quota.state_redis_error',
    );
  });
  client.on('ready', () => {
    if (!healthy) options.logger?.info({}, 'quota.state_redis_ready');
    healthy = true;
  });
  return client;
}
