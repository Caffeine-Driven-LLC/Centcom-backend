/**
 * The abuse block (B023, card test abuse-block.test.ts): an address that overruns the auth bucket
 * 5 times in 10 minutes is refused for 15 minutes in every bucket counted by address (anonymous,
 * auth, usage without an id), while signed-in callers from it are counted as usual. The block is
 * kept in the key-value store, so every instance honours it. Runs on every backend: in memory, and
 * on Redis 7 when REDIS_URL is set (CI's integration job).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ABUSE_BLOCK_S,
  ABUSE_STRIKES,
  ABUSE_WINDOW_S,
  createRateLimiter,
  type RateLimiter,
} from '../../src/index.js';
import { HARNESSES, memoryHarness, type Harness } from '../redis/helpers.js';
import {
  allowedCount,
  aUser,
  anonymous,
  captureLogger,
  checkTimes,
  labelledMetrics,
  testConfig,
} from './helpers.js';

const IP = '203.0.113.7';
const auth = anonymous(IP, { bucket: 'auth' });
/** The auth bucket's limit, then this many overruns. */
const overrun = (n: number): number => 20 + n;

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`the abuse block: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    const setup = async (): Promise<{
      h: Harness;
      limiter: RateLimiter;
      second: RateLimiter;
      counters: ReturnType<typeof labelledMetrics>;
      log: ReturnType<typeof captureLogger>;
    }> => {
      const h = await open();
      harness = h;
      const counters = labelledMetrics();
      const log = captureLogger();
      const make = (): RateLimiter =>
        createRateLimiter({
          store: h.backend.rateLimit,
          kv: h.backend.kv,
          config: testConfig(),
          clock: h.clock.read,
          logger: log.logger,
          metrics: counters.metrics,
        });
      return { h, limiter: make(), second: make(), counters, log };
    };

    it('blocks an address for 15 minutes on its 5th overrun of the auth bucket in 10 minutes', async () => {
      const { limiter, counters, log } = await setup();
      const before = await checkTimes(limiter, overrun(ABUSE_STRIKES - 1), auth);
      expect(allowedCount(before)).toBe(20);
      expect(before.some((d) => d.blocked)).toBe(false);
      expect(counters.count('ratelimit_blocks_total')).toBe(0);
      // The 5th overrun is refused like the others, and starts the block.
      expect(await limiter.check(auth)).toMatchObject({ allowed: false, blocked: false });
      expect(counters.count('ratelimit_blocks_total')).toBe(1);
      for (const request of [auth, anonymous(IP), anonymous(IP, { bucket: 'usage' })]) {
        const decision = await limiter.check(request);
        expect(decision).toMatchObject({ allowed: false, blocked: true, remaining: 0 });
        expect(decision.retryAfterS).toBeGreaterThan(ABUSE_BLOCK_S - 5);
        expect(decision.retryAfterS).toBeLessThanOrEqual(ABUSE_BLOCK_S);
        expect(decision.resetS).toBe(decision.retryAfterS);
      }
      expect(counters.count('ratelimit_denied_total', { bucket: 'anonymous' })).toBe(1);
      // Signed-in callers from the address are counted by who they are; other addresses go on.
      expect(await limiter.check(anonymous(IP, { principal: aUser() }))).toMatchObject({
        allowed: true,
        blocked: false,
      });
      expect(await limiter.check(anonymous('198.51.100.9', { bucket: 'auth' }))).toMatchObject({
        allowed: true,
        remaining: 19,
      });
      const warnings = log.lines().filter((l) => l['msg'] === 'ratelimit.ip_blocked');
      expect(warnings).toEqual([
        expect.objectContaining({ level: 'warn', client_ip: IP, block_s: ABUSE_BLOCK_S }),
      ]);
    });

    it('does not block four overruns, nor overruns more than 10 minutes apart', async () => {
      const { h, limiter, counters } = await setup();
      await checkTimes(limiter, overrun(ABUSE_STRIKES - 1), auth);
      h.clock.advance(ABUSE_WINDOW_S * 1000);
      const later = await checkTimes(limiter, overrun(ABUSE_STRIKES - 1), auth);
      expect(allowedCount(later)).toBe(20);
      expect(later.some((d) => d.blocked)).toBe(false);
      expect(counters.count('ratelimit_blocks_total')).toBe(0);
      expect(await limiter.check(anonymous(IP))).toMatchObject({ allowed: true });
    });

    it('is honoured by every instance sharing the key-value store', async () => {
      const { limiter, second } = await setup();
      await checkTimes(limiter, overrun(ABUSE_STRIKES), auth);
      expect(await second.check(anonymous(IP))).toMatchObject({ allowed: false, blocked: true });
    });

    it('starts once when a burst overruns many times at once', async () => {
      const { limiter, counters, log } = await setup();
      await checkTimes(limiter, 20, auth);
      const burst = await Promise.all(Array.from({ length: 12 }, () => limiter.check(auth)));
      expect(allowedCount(burst)).toBe(0);
      expect(counters.count('ratelimit_blocks_total')).toBe(1);
      expect(log.lines().filter((l) => l['msg'] === 'ratelimit.ip_blocked')).toHaveLength(1);
    });
  });
}

describe('the abuse block, in memory', () => {
  it('lifts after 15 minutes', async () => {
    const h = await memoryHarness();
    try {
      const limiter = createRateLimiter({
        store: h.backend.rateLimit,
        kv: h.backend.kv,
        config: testConfig(),
        clock: h.clock.read,
      });
      await checkTimes(limiter, overrun(ABUSE_STRIKES), auth);
      h.clock.advance((ABUSE_BLOCK_S - 1) * 1000);
      expect(await limiter.check(auth)).toMatchObject({ allowed: false, retryAfterS: 1 });
      h.clock.advance(1000);
      expect(await limiter.check(auth)).toMatchObject({ allowed: true, blocked: false });
    } finally {
      await h.close();
    }
  });
});
