/**
 * Failure modes (B009 acceptance 5, failure modes): a Redis that never answers makes commands
 * reject with a 503 AppError after the 2 s command timeout instead of hanging; a refused
 * connection does the same and is logged once without the URL; answers that are errors from
 * Redis itself pass through; closed backends refuse work; settings are checked without echoing
 * the URL; and the in-memory backend's key cap evicts the oldest keys.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppError,
  COMMAND_TIMEOUT_MS,
  createMemoryRedis,
  createRedis,
  keyPrefixFor,
  Secret,
  type RedisBackend,
} from '../../src/index.js';
import {
  captureLogger,
  closedPort,
  countingMetrics,
  FakeClock,
  REDIS_URL,
  redisHarness,
  silentServer,
  type Harness,
} from './helpers.js';

const PASSWORD = ['pw', 'redis', 'hidden'].join('-');
const PREFIX = keyPrefixFor('test');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function backendAt(
  port: number,
  extra: {
    logger?: ReturnType<typeof captureLogger>['logger'];
    metrics?: ReturnType<typeof countingMetrics>['metrics'];
  } = {},
): RedisBackend {
  const backend = createRedis({
    url: new Secret(`redis://default:${PASSWORD}@127.0.0.1:${port}/0`),
    keyPrefix: PREFIX,
    ...extra,
  });
  cleanups.push(() => backend.close());
  return backend;
}

/** Runs `op`, returning what it rejected with and how long that took. */
async function rejection(op: Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const started = performance.now();
  try {
    await op;
  } catch (err) {
    return { err, ms: performance.now() - started };
  }
  throw new Error('expected a rejection');
}

describe('a Redis that never answers (acceptance 5)', () => {
  it('rejects a command with a 503 AppError after the command timeout, without hanging', async () => {
    const silent = await silentServer();
    cleanups.push(silent.close);
    const backend = backendAt(silent.port);
    const { err, ms } = await rejection(backend.kv.get('k'));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(ms).toBeGreaterThanOrEqual(COMMAND_TIMEOUT_MS - 100);
    expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS + 1_500);
    expect(((err as AppError).cause as Error).message).toBe('Command timed out');
    await expect(backend.ping()).rejects.toMatchObject({ code: 'service_unavailable' });
  }, 15_000);
});

describe('a refused connection (failure mode: Redis down)', () => {
  it('rejects every kind of call with a 503, and logs the outage once without the URL', async () => {
    const { logger, raw, lines } = captureLogger();
    const { metrics, count } = countingMetrics();
    const backend = backendAt(await closedPort(), { logger, metrics });
    const calls: Promise<unknown>[] = [
      backend.kv.get('k'),
      backend.kv.set('k', 'v'),
      backend.kv.setIfAbsent('k', 'v', 1_000),
      backend.kv.incr('k', 1_000),
      backend.rateLimit.consume('k', 10, 60),
      backend.pubsub.publish('ch', 'm'),
      backend.ping(),
    ];
    const results = await Promise.allSettled(calls);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: 'service_unavailable',
      });
    }
    expect(count('redis_unavailable_total')).toBe(calls.length);
    const warnings = lines().filter((l) => l['msg'] === 'redis.connection_error');
    expect(warnings).toHaveLength(1);
    expect(count('redis_connection_errors_total')).toBeGreaterThanOrEqual(1);
    expect(raw()).not.toContain(PASSWORD);
    expect(raw()).toContain('ECONNREFUSED');
  }, 15_000);
});

describe('settings', () => {
  it('refuses a bad URL or prefix without quoting the URL', () => {
    for (const url of [`not a url ${PASSWORD}`, `http://user:${PASSWORD}@localhost:6379`]) {
      let err: unknown;
      try {
        createRedis({ url: new Secret(url), keyPrefix: PREFIX });
      } catch (e) {
        err = e;
      }
      expect(err, url).toBeInstanceOf(TypeError);
      expect(String(err)).not.toContain(PASSWORD);
    }
    for (const keyPrefix of ['', 'ct:', 'ct:Prod:', 'centcom:test:', 'ct:test']) {
      expect(
        () => createRedis({ url: new Secret('redis://localhost:6379'), keyPrefix }),
        keyPrefix,
      ).toThrow(TypeError);
    }
    expect(() => keyPrefixFor('Bad Env')).toThrow(TypeError);
    expect(keyPrefixFor('production')).toBe('ct:production:');
  });
});

describe('closed backends', () => {
  it('refuse work with a 503 (in memory)', async () => {
    const backend = createMemoryRedis();
    await backend.close();
    for (const op of [
      backend.kv.get('k'),
      backend.pubsub.publish('c', 'm'),
      backend.rateLimit.consume('k', 1, 1),
      backend.ping(),
    ]) {
      await expect(op).rejects.toMatchObject({ code: 'service_unavailable' });
    }
  });

  it('refuse work with a 503 (Redis client), and close twice without complaint', async () => {
    const backend = backendAt(await closedPort());
    await backend.close();
    await backend.close();
    await expect(backend.kv.get('k')).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});

describe('the in-memory key cap', () => {
  it('sweeps expired keys, then evicts the oldest written, counting evictions', async () => {
    const clock = new FakeClock();
    const { metrics, count } = countingMetrics();
    const backend = createMemoryRedis(clock.read, { maxKeys: 3, metrics });
    await backend.kv.set('short', 'v', { ttlMs: 10 });
    await backend.kv.set('a', 'v', { ttlMs: 60_000 });
    await backend.kv.set('b', 'v', { ttlMs: 60_000 });
    clock.advance(20); // 'short' has expired: it goes first, nothing live is evicted
    await backend.kv.set('c', 'v', { ttlMs: 60_000 });
    expect(count('redis_memory_evictions_total')).toBe(0);
    await backend.kv.set('d', 'v', { ttlMs: 60_000 });
    expect(count('redis_memory_evictions_total')).toBe(1);
    expect(await backend.kv.get('a')).toBeNull();
    expect(await Promise.all(['b', 'c', 'd'].map((k) => backend.kv.get(k)))).toEqual([
      'v',
      'v',
      'v',
    ]);
    expect(() => createMemoryRedis(clock.read, { maxKeys: 0 })).toThrow(RangeError);
  });
});

describe.runIf(REDIS_URL !== undefined)('errors from Redis itself', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('pass through as they are: a bug to fix, not an outage', async () => {
    harness = await redisHarness();
    await harness.backend.kv.set('word', 'abc', { ttlMs: 60_000 });
    const err = await harness.backend.kv.incr('word', 60_000).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AppError);
    expect(err).toMatchObject({ name: 'ReplyError' });
  });
});
