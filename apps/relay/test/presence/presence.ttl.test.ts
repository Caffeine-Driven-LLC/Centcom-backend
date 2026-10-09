/**
 * The store's expiry (B047; tests "presence.ttl.test.ts", acceptance 7, failure mode "Redis
 * unavailable"): a session's `presence:{sid}` key lives 60 s after its last write, so a crashed node
 * leaves no permanent ghost; an entry older than 60 s is never read even while others keep the key
 * alive; `remove` only takes an entry its node wrote. On Redis 7 (REDIS_URL or a container; skipped
 * without one) and in memory. When Redis fails, presence uses node-local memory and logs once.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryPresenceStore,
  createRedisPresenceStore,
  PRESENCE_TTL_MS,
  presenceKey,
  withFallback,
  type PresenceStore,
} from '../../src/presence/store.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import {
  REDIS,
  REDIS_TIMEOUT_MS,
  startRedisHarness,
  type RedisHarness,
} from '../seq/redis-helpers.js';

const entry = (at: number, node = 'node-a') => ({
  p: { status: 'online' as const, activity: 'idle' as const },
  at,
  node,
});

describe('in memory', () => {
  it('expires a session 60 s after its last write; skips entries older than 60 s', async () => {
    let now = 1_000_000;
    const store = createMemoryPresenceStore(() => now);
    const sid = newId('ses');
    const [a, b] = [newId('mem'), newId('mem')];
    await store.write(sid, a, entry(now));
    now += 40_000;
    await store.write(sid, b, entry(now));
    now += 30_000;
    // The key lives (b refreshed it), but a's entry is 70 s old.
    expect([...(await store.read(sid)).keys()]).toEqual([b]);
    now += PRESENCE_TTL_MS;
    expect((await store.read(sid)).size).toBe(0);
    expect(store.sessions()).toBe(0);
  });

  it('removes only an entry its node wrote; clear forgets the session', async () => {
    const store = createMemoryPresenceStore();
    const sid = newId('ses');
    const m = newId('mem');
    await store.write(sid, m, entry(Date.now(), 'node-b'));
    await store.remove(sid, m, 'node-a');
    expect((await store.read(sid)).has(m)).toBe(true);
    await store.remove(sid, m, 'node-b');
    expect((await store.read(sid)).has(m)).toBe(false);
    await store.write(sid, m, entry(Date.now()));
    await store.clear(sid);
    expect((await store.read(sid)).size).toBe(0);
  });
});

describe('when Redis fails', () => {
  it('uses node-local memory for the call and logs once', async () => {
    const down: PresenceStore = {
      write: () => Promise.reject(new Error('down')),
      read: () => Promise.reject(new Error('down')),
      remove: () => Promise.reject(new Error('down')),
      clear: () => Promise.reject(new Error('down')),
    };
    const log = captureLogger();
    const recorded = recordingMetrics();
    const store = withFallback(down, createMemoryPresenceStore(), {
      logger: log.logger,
      metrics: recorded.metrics,
    });
    const sid = newId('ses');
    const m = newId('mem');
    await store.write(sid, m, entry(Date.now()));
    expect((await store.read(sid)).has(m)).toBe(true);
    await store.remove(sid, m, 'node-a');
    await store.clear(sid);
    expect(log.lines().filter((l) => l['msg'] === 'relay.presence_store_unavailable')).toHaveLength(
      1,
    );
    expect(recorded.count('relay_presence_store_failed_total')).toBe(4);
  });
});

describe.runIf(REDIS)('on Redis 7 (acceptance 7)', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  it('keeps presence:{sid} for 60 s after the last write, as one hash per session', async () => {
    const prefix = redis.prefix();
    const store = createRedisPresenceStore(redis.client(prefix));
    const sid = newId('ses');
    const [a, b] = [newId('mem'), newId('mem')];
    await store.write(sid, a, entry(Date.now()));
    await store.write(sid, b, entry(Date.now() - PRESENCE_TTL_MS - 1));
    const ttl = await redis.admin.pttl(`${prefix}${presenceKey(sid)}`);
    expect(ttl).toBeGreaterThan(PRESENCE_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_MS);
    expect(await redis.admin.hlen(`${prefix}${presenceKey(sid)}`)).toBe(2);
    // b's entry is stale: never read.
    expect([...(await store.read(sid)).keys()]).toEqual([a]);
    await store.remove(sid, a, 'node-b');
    expect((await store.read(sid)).has(a)).toBe(true);
    await store.remove(sid, a, 'node-a');
    expect((await store.read(sid)).has(a)).toBe(false);
    await store.clear(sid);
    expect(await redis.admin.exists(`${prefix}${presenceKey(sid)}`)).toBe(0);
  }, 120_000);

  it('a key whose TTL ran out is gone (no ghost after a crash)', async () => {
    const prefix = redis.prefix();
    const client = redis.client(prefix);
    const store = createRedisPresenceStore(client);
    const sid = newId('ses');
    await store.write(sid, newId('mem'), entry(Date.now()));
    // Time passes for Redis: the TTL is shortened instead of waiting 60 s.
    await client.pexpire(presenceKey(sid), 50);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await store.read(sid)).size).toBe(0);
  }, 120_000);
});
