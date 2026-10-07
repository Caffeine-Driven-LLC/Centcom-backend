/**
 * RateLimitStore contract (B009 acceptance 1, 3 and 4): the same cases against every backend on a
 * fake clock. 30 calls in a window and a 31st denied with remaining 0; an empty window again after
 * a full window; a window that slides; costs; 50 concurrent callers; argument limits; and on
 * Redis, the bucket's TTL and recovery from an evicted script (NOSCRIPT).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RATE_LIMIT, MAX_WINDOW_S, type RateLimitStore } from '../../src/index.js';
import { HARNESSES, REDIS_URL, redisHarness, type Harness } from './helpers.js';

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`RateLimitStore contract: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });
    const setup = async (): Promise<{ store: RateLimitStore; h: Harness }> => {
      harness = await open();
      return { store: harness.backend.rateLimit, h: harness };
    };

    it("consume('k', 30, 60) allows 30 calls in one window and denies the 31st (acceptance 3)", async () => {
      const { store, h } = await setup();
      for (let i = 1; i <= 30; i++) {
        const result = await store.consume('k', 30, 60);
        expect(result, `call ${i}`).toMatchObject({ allowed: true, limit: 30, remaining: 30 - i });
        h.clock.advance(1_000);
      }
      const denied = await store.consume('k', 30, 60);
      expect(denied).toMatchObject({ allowed: false, limit: 30, remaining: 0 });
      expect(denied.resetS).toBeGreaterThanOrEqual(1);
      expect(denied.resetS).toBeLessThanOrEqual(60);
      // The oldest call was 30 s ago: a slot frees in 30 s.
      expect(denied.resetS).toBe(30);
    });

    it('is empty again after a full window (acceptance 4)', async () => {
      const { store, h } = await setup();
      for (let i = 0; i < 30; i++) await store.consume('k', 30, 60);
      expect((await store.consume('k', 30, 60)).allowed).toBe(false);
      h.clock.advance(60_000);
      expect(await store.consume('k', 30, 60)).toMatchObject({ allowed: true, remaining: 29 });
    });

    it('slides: calls leave the window one by one as they age', async () => {
      const { store, h } = await setup();
      for (let i = 0; i < 10; i++) await store.consume('k', 30, 60);
      h.clock.advance(30_000);
      for (let i = 0; i < 20; i++) await store.consume('k', 30, 60);
      expect((await store.consume('k', 30, 60)).allowed).toBe(false);
      h.clock.advance(30_001); // the first 10 have aged out, the last 20 have not
      expect(await store.consume('k', 30, 60)).toMatchObject({ allowed: true, remaining: 9 });
    });

    it('a denied call counts nothing', async () => {
      const { store } = await setup();
      for (let i = 0; i < 5; i++) await store.consume('k', 5, 60);
      for (let i = 0; i < 10; i++) expect((await store.consume('k', 5, 60)).allowed).toBe(false);
      expect((await store.consume('k', 5, 60)).remaining).toBe(0);
    });

    it('counts a cost, and refuses a cost that does not fit without counting it', async () => {
      const { store } = await setup();
      expect(await store.consume('k', 10, 60, 4)).toMatchObject({ allowed: true, remaining: 6 });
      expect(await store.consume('k', 10, 60, 7)).toMatchObject({ allowed: false, remaining: 6 });
      expect(await store.consume('k', 10, 60, 6)).toMatchObject({ allowed: true, remaining: 0 });
    });

    it('keeps buckets apart', async () => {
      const { store } = await setup();
      for (let i = 0; i < 3; i++) await store.consume('a', 3, 60);
      expect((await store.consume('a', 3, 60)).allowed).toBe(false);
      expect(await store.consume('b', 3, 60)).toMatchObject({ allowed: true, remaining: 2 });
    });

    it('lets exactly limit of 50 concurrent callers through', async () => {
      const { store } = await setup();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.consume('burst', 30, 60)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(30);
      expect(results.filter((r) => !r.allowed).every((r) => r.remaining === 0)).toBe(true);
    });

    it('reports resetS as the whole window when the bucket was empty', async () => {
      const { store } = await setup();
      expect((await store.consume('fresh', 10, 45)).resetS).toBe(45);
    });

    it('refuses bad arguments before touching the store', async () => {
      const { store } = await setup();
      for (const [limit, windowS, cost] of [
        [0, 60, 1],
        [MAX_RATE_LIMIT + 1, 60, 1],
        [10, 0, 1],
        [10, MAX_WINDOW_S + 1, 1],
        [10, 60, 0],
        [10, 60, 11],
        [1.5, 60, 1],
      ] as const) {
        await expect(
          store.consume('k', limit, windowS, cost),
          `${limit}/${windowS}/${cost}`,
        ).rejects.toThrow(RangeError);
      }
      await expect(store.consume('', 10, 60)).rejects.toThrow(TypeError);
    });
  });
}

describe.runIf(REDIS_URL !== undefined)('rate limiting on Redis', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('gives the bucket a TTL of at most the window', async () => {
    harness = await redisHarness();
    const { backend, admin, prefix } = harness;
    if (admin === undefined) throw new Error('the Redis harness has an admin client');
    await backend.rateLimit.consume('ttl-check', 10, 60);
    const ttl = await admin.pttl(`${prefix}ttl-check`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('reloads the script after the server evicted it (NOSCRIPT) and carries on', async () => {
    harness = await redisHarness();
    const { backend, admin } = harness;
    if (admin === undefined) throw new Error('the Redis harness has an admin client');
    await backend.rateLimit.consume('noscript', 10, 60);
    await admin.script('FLUSH');
    expect(await backend.rateLimit.consume('noscript', 10, 60)).toMatchObject({
      allowed: true,
      remaining: 8,
    });
    expect(await backend.kv.incr('noscript-counter', 60_000)).toBe(1);
  });
});
