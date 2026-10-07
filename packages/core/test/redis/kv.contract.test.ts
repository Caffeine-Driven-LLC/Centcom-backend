/**
 * KeyValue contract (B009 acceptance 1, 2 and 7): the same cases against every backend. get/set,
 * TTLs (every key has one), setIfAbsent (exactly one winner among 100 concurrent calls), del, incr
 * and argument limits; on Redis also that every key carries the `ct:<env>:` prefix and a TTL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TTL_MS,
  MAX_KEY_LENGTH,
  MAX_TTL_MS,
  MAX_VALUE_BYTES,
  type KeyValue,
} from '../../src/index.js';
import { HARNESSES, REDIS_URL, redisHarness, type Harness } from './helpers.js';

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`KeyValue contract: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });
    const setup = async (): Promise<{ kv: KeyValue; h: Harness }> => {
      harness = await open();
      return { kv: harness.backend.kv, h: harness };
    };

    it('stores and returns strings; a missing key is null', async () => {
      const { kv } = await setup();
      expect(await kv.get('missing')).toBeNull();
      await kv.set('greeting', 'hello', { ttlMs: 60_000 });
      expect(await kv.get('greeting')).toBe('hello');
      await kv.set('greeting', 'grüß dich ✓', { ttlMs: 60_000 });
      expect(await kv.get('greeting')).toBe('grüß dich ✓');
      await kv.set('empty', '', { ttlMs: 60_000 });
      expect(await kv.get('empty')).toBe('');
    });

    it('gives every key a TTL: the one asked for, or DEFAULT_TTL_MS', async () => {
      const { kv } = await setup();
      await kv.set('short', 'v', { ttlMs: 5_000 });
      await kv.set('default', 'v');
      const short = await kv.ttl('short');
      const fallback = await kv.ttl('default');
      expect(short).toBeGreaterThan(4_000);
      expect(short).toBeLessThanOrEqual(5_000);
      expect(fallback).toBeGreaterThan(DEFAULT_TTL_MS - 5_000);
      expect(fallback).toBeLessThanOrEqual(DEFAULT_TTL_MS);
      expect(await kv.ttl('missing')).toBeNull();
    });

    it('forgets a key once its TTL has passed', async () => {
      const { kv, h } = await setup();
      await kv.set('brief', 'v', { ttlMs: 100 });
      await h.wait(250);
      expect(await kv.get('brief')).toBeNull();
      expect(await kv.ttl('brief')).toBeNull();
    });

    it('set replaces both the value and the TTL', async () => {
      const { kv } = await setup();
      await kv.set('k', 'one', { ttlMs: 1_000 });
      await kv.set('k', 'two', { ttlMs: 60_000 });
      expect(await kv.get('k')).toBe('two');
      expect(await kv.ttl('k')).toBeGreaterThan(30_000);
    });

    it('setIfAbsent stores only when the key is absent, and again once it expired', async () => {
      const { kv, h } = await setup();
      expect(await kv.setIfAbsent('jti', 'first', 100)).toBe(true);
      expect(await kv.setIfAbsent('jti', 'second', 100)).toBe(false);
      expect(await kv.get('jti')).toBe('first');
      await h.wait(250);
      expect(await kv.setIfAbsent('jti', 'third', 60_000)).toBe(true);
      expect(await kv.get('jti')).toBe('third');
    });

    it('setIfAbsent called 100 times at once on one key returns true exactly once (acceptance 2)', async () => {
      const { kv } = await setup();
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => kv.setIfAbsent('race', `caller-${i}`, 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect(await kv.get('race')).toBe(`caller-${winner}`);
    });

    it('del removes a key and reports whether it existed', async () => {
      const { kv } = await setup();
      await kv.set('gone', 'v', { ttlMs: 60_000 });
      expect(await kv.del('gone')).toBe(1);
      expect(await kv.del('gone')).toBe(0);
      expect(await kv.get('gone')).toBeNull();
    });

    it('incr starts a new key at 1 with its TTL and keeps the TTL of an existing one', async () => {
      const { kv, h } = await setup();
      expect(await kv.incr('hits', 10_000)).toBe(1);
      const first = await kv.ttl('hits');
      expect(first).toBeGreaterThan(9_000);
      await h.wait(300);
      expect(await kv.incr('hits', 10_000)).toBe(2);
      // Not reset by the second incr: the window stays fixed.
      expect(await kv.ttl('hits')).toBeLessThanOrEqual((first ?? 0) - 250);
      expect(await kv.get('hits')).toBe('2');
    });

    it('incr counts every one of 50 concurrent calls', async () => {
      const { kv } = await setup();
      const values = await Promise.all(
        Array.from({ length: 50 }, () => kv.incr('concurrent', 60_000)),
      );
      expect([...values].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    });

    it('incr refuses a value that is not an integer', async () => {
      const { kv } = await setup();
      await kv.set('word', 'abc', { ttlMs: 60_000 });
      await expect(kv.incr('word', 60_000)).rejects.toThrow();
      expect(await kv.get('word')).toBe('abc');
    });

    it('refuses bad keys, values and TTLs before touching the store', async () => {
      const { kv } = await setup();
      await expect(kv.get('')).rejects.toThrow(TypeError);
      await expect(kv.get('k'.repeat(MAX_KEY_LENGTH + 1))).rejects.toThrow(TypeError);
      await expect(kv.set('k', 'v', { ttlMs: 0 })).rejects.toThrow(RangeError);
      await expect(kv.set('k', 'v', { ttlMs: 1.5 })).rejects.toThrow(RangeError);
      await expect(kv.set('k', 'v', { ttlMs: MAX_TTL_MS + 1 })).rejects.toThrow(RangeError);
      await expect(kv.setIfAbsent('k', 'v', -1)).rejects.toThrow(RangeError);
      await expect(kv.incr('k', Number.NaN)).rejects.toThrow(RangeError);
      await expect(kv.set('k', 'x'.repeat(MAX_VALUE_BYTES + 1), { ttlMs: 1_000 })).rejects.toThrow(
        RangeError,
      );
      await expect(kv.set('k', 42 as unknown as string)).rejects.toThrow(TypeError);
      expect(await kv.get('k')).toBeNull();
    });
  });
}

describe.runIf(REDIS_URL !== undefined)('keys on Redis (acceptance 7)', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('carry the ct:<env>: prefix and a TTL, whatever wrote them', async () => {
    harness = await redisHarness();
    const { backend, admin, prefix } = harness;
    if (admin === undefined) throw new Error('the Redis harness has an admin client');
    const marker = `m${Date.now()}`;
    await backend.kv.set(`${marker}:set`, 'v');
    await backend.kv.set(`${marker}:ttl`, 'v', { ttlMs: 60_000 });
    await backend.kv.setIfAbsent(`${marker}:nx`, 'v', 60_000);
    await backend.kv.incr(`${marker}:incr`, 60_000);
    await backend.rateLimit.consume(`${marker}:bucket`, 10, 60);
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await admin.scan(cursor, 'MATCH', `*${marker}*`, 'COUNT', 1_000);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    expect(keys.sort()).toEqual(
      ['bucket', 'incr', 'nx', 'set', 'ttl'].map((suffix) => `${prefix}${marker}:${suffix}`),
    );
    for (const key of keys) {
      const ttl = await admin.pttl(key);
      expect(ttl, key).toBeGreaterThan(0);
    }
  });
});
