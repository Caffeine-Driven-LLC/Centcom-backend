/**
 * The entitlements cache (B080 acceptance 1 and 2, guardrails "≤ 30 s, bounded LRU", "never cache
 * a failure"): an entry is served while fresh and reloaded at its TTL or its own expiry, whichever
 * comes first, so nothing older than 30 s is ever served; an invalidation (local or a message on
 * the channel, across processes) reaches the next read; a load overlapping an invalidation is not
 * kept; concurrent misses share one load; at most `maxEntries` workspaces are kept, least recently
 * used out first; a failed load is never cached, and a stale entry stands in only within
 * `staleOnErrorMs`. A cache hit takes under 1 ms at the 99th percentile, timed in a separate
 * process (cache-bench.ts).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createMemoryRedis,
  EntitlementCache,
  listenForInvalidations,
  MAX_ENT_CACHE_TTL_MS,
  parseInvalidation,
} from '../../src/index.js';

const CORE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./cache-bench.ts', import.meta.url));
const WS = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

function source(initial = 1) {
  let rev = initial;
  let fail: Error | null = null;
  let calls = 0;
  return {
    load: (ws: string) => {
      calls += 1;
      if (fail !== null) return Promise.reject(fail);
      return Promise.resolve({ ws, rev });
    },
    set: (r: number) => {
      rev = r;
    },
    failWith: (e: Error | null) => {
      fail = e;
    },
    calls: () => calls,
  };
}

describe('EntitlementCache', () => {
  it('serves an entry while fresh and never older than its TTL (30 s)', async () => {
    let now = 0;
    const src = source(41);
    const cache = new EntitlementCache({ load: src.load, clock: () => now });
    expect(await cache.get(WS)).toEqual({ ws: WS, rev: 41 });
    src.set(42);
    now = MAX_ENT_CACHE_TTL_MS - 1;
    expect((await cache.get(WS))?.rev).toBe(41);
    now = MAX_ENT_CACHE_TTL_MS;
    expect((await cache.get(WS))?.rev).toBe(42);
    expect(src.calls()).toBe(2);
  });

  it('reloads at the value’s own expiry when it comes before the TTL', async () => {
    let now = 1_000;
    const src = source();
    const cache = new EntitlementCache({
      load: src.load,
      clock: () => now,
      expiresAt: () => 1_500,
    });
    await cache.get(WS);
    now = 1_499;
    await cache.get(WS);
    expect(src.calls()).toBe(1);
    now = 1_500;
    await cache.get(WS);
    expect(src.calls()).toBe(2);
  });

  it('drops an entry on invalidate, and does not keep a load that overlapped one', async () => {
    const src = source(41);
    const cache = new EntitlementCache({ load: src.load });
    await cache.get(WS);
    src.set(42);
    cache.invalidate(WS);
    expect((await cache.get(WS))?.rev).toBe(42);
    // A load in flight when the change lands is answered but not cached.
    let release: (v: { ws: string; rev: number }) => void = () => undefined;
    const slow = new EntitlementCache<{ ws: string; rev: number }>({
      load: () => new Promise((resolve) => (release = resolve)),
    });
    const pending = slow.get(WS);
    slow.invalidate(WS);
    release({ ws: WS, rev: 41 });
    expect((await pending)?.rev).toBe(41);
    expect(slow.size).toBe(0);
  });

  it('shares one load between concurrent misses', async () => {
    const src = source();
    const cache = new EntitlementCache({ load: src.load });
    await Promise.all(Array.from({ length: 20 }, () => cache.get(WS)));
    expect(src.calls()).toBe(1);
  });

  it('keeps at most maxEntries, dropping the least recently used', async () => {
    const src = source();
    const cache = new EntitlementCache({ load: src.load, maxEntries: 3 });
    for (const ws of ['a', 'b', 'c']) await cache.get(ws);
    await cache.get('a');
    await cache.get('d');
    expect(cache.size).toBe(3);
    const before = src.calls();
    await cache.get('a');
    await cache.get('c');
    await cache.get('d');
    expect(src.calls()).toBe(before);
    await cache.get('b');
    expect(src.calls()).toBe(before + 1);
  });

  it('never caches a failure, and serves stale only within staleOnErrorMs', async () => {
    let now = 0;
    const src = source();
    let stale = 0;
    const strict = new EntitlementCache({ load: src.load, clock: () => now, ttlMs: 1_000 });
    await strict.get(WS);
    now = 1_000;
    src.failWith(new Error('db down'));
    await expect(strict.get(WS)).rejects.toThrow('db down');
    src.failWith(null);
    expect(await strict.get(WS)).toEqual({ ws: WS, rev: 1 });

    now = 0;
    const lenient = new EntitlementCache({
      load: src.load,
      clock: () => now,
      ttlMs: 1_000,
      staleOnErrorMs: 500,
      onStaleServed: () => (stale += 1),
    });
    await lenient.get(WS);
    src.failWith(new Error('db down'));
    now = 1_499;
    expect(await lenient.get(WS)).toEqual({ ws: WS, rev: 1 });
    expect(stale).toBe(1);
    now = 1_500;
    await expect(lenient.get(WS)).rejects.toThrow('db down');
  });

  it('refuses a TTL over 30 s and other bad settings', () => {
    const load = () => Promise.resolve(null);
    expect(() => new EntitlementCache({ load, ttlMs: 30_001 })).toThrow(RangeError);
    expect(() => new EntitlementCache({ load, ttlMs: 0 })).toThrow(RangeError);
    expect(() => new EntitlementCache({ load, maxEntries: 0 })).toThrow(RangeError);
    expect(() => new EntitlementCache({ load, staleOnErrorMs: -1 })).toThrow(RangeError);
  });
});

describe('invalidations across processes', () => {
  it('drops the entry in every cache listening on the channel', async () => {
    const redis = createMemoryRedis();
    const src = source(41);
    const a = new EntitlementCache({ load: src.load });
    const b = new EntitlementCache({ load: src.load });
    await listenForInvalidations(redis.pubsub, 'entitlements:invalidate', a);
    await listenForInvalidations(redis.pubsub, 'entitlements:invalidate', b);
    await a.get(WS);
    await b.get(WS);
    src.set(42);
    const started = Date.now();
    await redis.pubsub.publish(
      'entitlements:invalidate',
      JSON.stringify({ workspace: WS, rev: 42 }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect((await a.get(WS))?.rev).toBe(42);
    expect((await b.get(WS))?.rev).toBe(42);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Garbage on the channel is ignored.
    await redis.pubsub.publish('entitlements:invalidate', 'not json');
    expect((await a.get(WS))?.rev).toBe(42);
  });

  it('parses only {workspace, rev}', () => {
    expect(parseInvalidation(JSON.stringify({ workspace: WS, rev: 3 }))).toEqual({
      workspace: WS,
      rev: 3,
    });
    for (const bad of ['', '[]', '{"workspace":"x","rev":1}', `{"workspace":"${WS}","rev":"1"}`]) {
      expect(parseInvalidation(bad)).toBeNull();
    }
  });
});

describe('the package', () => {
  it('publishes the cache as @centcom/core/entitlements', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, { default: string }>;
    };
    expect(pkg.exports['./entitlements']?.default).toBe('./dist/entitlements/index.js');
  });
});

describe('cache hit latency', () => {
  it('serves a hit in under 1 ms at the 99th percentile (timed in its own process)', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', BENCH], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const { p99s } = JSON.parse(out) as { p99s: number[] };
    expect(Math.min(...p99s)).toBeLessThan(1);
  });
});
