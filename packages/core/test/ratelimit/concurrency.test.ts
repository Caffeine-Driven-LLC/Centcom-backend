/**
 * Concurrency (B023, card test concurrency.test.ts): 100 parallel requests never get more than the
 * limit through, with costs too, and two limiters on one store (two API instances) share one
 * bucket. Runs on every backend: in memory, and on Redis 7 when REDIS_URL is set (the card's Redis
 * integration test, CI's integration job); then once more on the per-process fallback.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRateLimiter, type LimitDecision, type RateLimiter } from '../../src/index.js';
import { HARNESSES, type Harness } from '../redis/helpers.js';
import { allowedCount, aUser, anonymous, setup, testConfig } from './helpers.js';

const IP = '203.0.113.7';
const parallel = (
  n: number,
  run: (i: number) => Promise<LimitDecision>,
): Promise<LimitDecision[]> => Promise.all(Array.from({ length: n }, (_, i) => run(i)));

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`under concurrency: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });
    const limiterOn = (h: Harness): RateLimiter =>
      createRateLimiter({
        store: h.backend.rateLimit,
        kv: h.backend.kv,
        config: testConfig(),
        clock: h.clock.read,
      });

    it('lets exactly 30 of 100 parallel anonymous requests through, each counted once', async () => {
      harness = await open();
      const limiter = limiterOn(harness);
      const decisions = await parallel(100, () => limiter.check(anonymous(IP)));
      expect(allowedCount(decisions)).toBe(30);
      const remaining = decisions.filter((d) => d.allowed).map((d) => d.remaining);
      expect(remaining.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(decisions.filter((d) => !d.allowed).every((d) => d.remaining === 0)).toBe(true);
    });

    it('never goes past the limit with costly requests', async () => {
      harness = await open();
      const limiter = limiterOn(harness);
      const user = aUser();
      const decisions = await parallel(100, () =>
        limiter.check(anonymous(IP, { principal: user, cost: 7 })),
      );
      // 600 units, 7 a request: 85 fit.
      expect(allowedCount(decisions)).toBe(85);
    });

    it('shares one bucket between two instances on one store', async () => {
      harness = await open();
      const [a, b] = [limiterOn(harness), limiterOn(harness)];
      const decisions = await parallel(100, (i) => (i % 2 === 0 ? a : b).check(anonymous(IP)));
      expect(allowedCount(decisions)).toBe(30);
      // Each user has a bucket of their own.
      const [first, second] = [aUser(), aUser()];
      expect(await a.check(anonymous(IP, { principal: first }))).toMatchObject({
        remaining: 599,
      });
      expect(await b.check(anonymous(IP, { principal: second }))).toMatchObject({
        remaining: 599,
      });
    });
  });
}

describe('under concurrency on the fallback', () => {
  it('lets exactly twice the limit of 100 parallel requests through', async () => {
    const t = setup(testConfig());
    t.store.down = true;
    const decisions = await parallel(100, () => t.limiter.check(anonymous(IP)));
    expect(allowedCount(decisions)).toBe(60);
    expect(decisions.every((d) => d.degraded)).toBe(true);
  });
});
