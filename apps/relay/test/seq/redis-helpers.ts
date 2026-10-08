/**
 * A real Redis for the sequencing tests (B041): REDIS_URL when set (CI's integration job), else a
 * Redis 7 container (B010's testcontainers runtime, CI's test job), else none and the suites that
 * need it skip. Every store gets its own `ct:t…:` key prefix, deleted again by `cleanup()`.
 */
import { randomBytes } from 'node:crypto';
import { defineConfig, keyPrefixFor, Secret, z } from '@centcom/core';
import { testcontainersRuntime } from '@centcom/testkit';
import { Redis } from 'ioredis';
import { createRedisSeqStore, createSeqRedisClient } from '../../src/seq/redis-store.js';
import type { BufferLimits, SeqStore } from '../../src/seq/types.js';

const env = defineConfig(z.object({ REDIS_URL: z.string().optional() }));

/** A Redis is reachable here: REDIS_URL, or a container runtime to start one. */
export const REDIS =
  env.REDIS_URL !== undefined ||
  (await testcontainersRuntime.check().then(
    () => true,
    () => false,
  ));
/** Starting a container can take a while on a cold runner. */
export const REDIS_TIMEOUT_MS = 180_000;

/** Stores on one Redis, each under a fresh prefix. */
export interface RedisHarness {
  url: string;
  /** A fresh `ct:t<hex>:` prefix. */
  prefix(): string;
  /** A sequencing connection under `prefix` (closed by `cleanup`). */
  client(prefix: string): Redis;
  /** A store on a new connection under a fresh prefix. */
  store(limits: BufferLimits): { store: SeqStore; client: Redis; prefix: string };
  /** A connection without a prefix, for looking at raw keys. */
  admin: Redis;
  /** Closes every connection and deletes every key written under the harness's prefixes. */
  cleanup(): Promise<void>;
}

/** Connects to REDIS_URL or starts a container. */
export async function startRedisHarness(): Promise<RedisHarness> {
  let stop: (() => Promise<void>) | undefined;
  const url: string =
    env.REDIS_URL ??
    (await testcontainersRuntime.startRedis().then((started) => {
      stop = started.stop;
      return started.url;
    }));
  const admin = new Redis(url, { maxRetriesPerRequest: 1 });
  const clients: Redis[] = [];
  const prefixes: string[] = [];
  const secret = new Secret(url);
  const harness: RedisHarness = {
    url,
    admin,
    prefix() {
      const prefix = keyPrefixFor(`t${randomBytes(5).toString('hex')}`);
      prefixes.push(prefix);
      return prefix;
    },
    client(prefix) {
      const client = createSeqRedisClient({ url: secret, keyPrefix: prefix });
      clients.push(client);
      return client;
    },
    store(limits) {
      const prefix = harness.prefix();
      const client = harness.client(prefix);
      return { store: createRedisSeqStore(client, limits), client, prefix };
    },
    async cleanup() {
      for (const client of clients) client.disconnect();
      for (const prefix of prefixes) {
        let cursor = '0';
        do {
          const [next, keys] = await admin.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1_000);
          cursor = next;
          if (keys.length > 0) await admin.del(...keys);
        } while (cursor !== '0');
      }
      admin.disconnect();
      await stop?.();
    },
  };
  return harness;
}
