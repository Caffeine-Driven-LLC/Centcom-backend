/**
 * The store failure policy (B023, card test fallback.test.ts; acceptance 7): with the shared store
 * failing, general buckets still limit through the per-process fallback at twice their limit, the
 * auth bucket stays at its own, `ratelimit_store_errors_total` counts each failure, a warning is
 * logged at most once a minute, and the store is tried again (and recovery noticed) within
 * STORE_RETRY_MS.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryRedis,
  createRateLimiter,
  STORE_RETRY_MS,
  STORE_WARNING_INTERVAL_MS,
} from '../../src/index.js';
import {
  allowedCount,
  aUser,
  anonymous,
  checkTimes,
  FakeClock,
  flakyStore,
  setup,
  testConfig,
} from './helpers.js';

describe('when the store fails', () => {
  it('limits general buckets per process at twice their limit (acceptance 7)', async () => {
    const t = setup();
    t.store.down = true;
    const anon = await checkTimes(t.limiter, 61, anonymous('203.0.113.7'));
    expect(allowedCount(anon)).toBe(60);
    expect(anon[0]).toMatchObject({ allowed: true, limit: 60, remaining: 59, degraded: true });
    expect(anon[60]).toMatchObject({ allowed: false, remaining: 0, degraded: true });
    expect(anon[60]?.retryAfterS).toBeGreaterThanOrEqual(1);
    const user = aUser();
    const signedIn = await checkTimes(
      t.limiter,
      1201,
      anonymous('203.0.113.7', { principal: user }),
    );
    expect(allowedCount(signedIn)).toBe(1200);
    expect(t.counters.count('ratelimit_store_errors_total')).toBeGreaterThanOrEqual(1);
  });

  it('keeps the auth bucket at its own limit (acceptance 7)', async () => {
    const t = setup();
    t.store.down = true;
    const auth = await checkTimes(t.limiter, 21, anonymous('203.0.113.7', { bucket: 'auth' }));
    expect(allowedCount(auth)).toBe(20);
    expect(auth[0]).toMatchObject({ limit: 20, degraded: true });
    expect(auth[20]).toMatchObject({ allowed: false, bucket: 'auth' });
  });

  it('counts each failure, warns at most once a minute, and never logs the error text', async () => {
    const t = setup();
    t.store.down = true;
    await t.limiter.check(anonymous('203.0.113.7'));
    expect(t.counters.count('ratelimit_store_errors_total')).toBe(1);
    // While the store rests, the fallback answers alone: no new store calls, no new errors.
    const calls = t.store.calls;
    await checkTimes(t.limiter, 5, anonymous('203.0.113.7'));
    expect(t.store.calls).toBe(calls);
    // After STORE_RETRY_MS it is tried again; it fails again: counted, but no second warning yet.
    t.clock.advance(STORE_RETRY_MS);
    await t.limiter.check(anonymous('203.0.113.7'));
    expect(t.counters.count('ratelimit_store_errors_total')).toBe(2);
    const warnings = (): Record<string, unknown>[] =>
      t.log.lines().filter((l) => l['msg'] === 'ratelimit.store_unavailable');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      level: 'warn',
      store: 'counters',
      reason: 'service_unavailable',
      retry_in_ms: STORE_RETRY_MS,
    });
    t.clock.advance(STORE_WARNING_INTERVAL_MS);
    await t.limiter.check(anonymous('203.0.113.7'));
    expect(warnings()).toHaveLength(2);
    expect(t.log.raw()).not.toContain('10.9.8.7');
    expect(t.log.raw()).not.toContain('ECONNREFUSED');
  });

  it('names a failure that is not an AppError just "error"', async () => {
    const t = setup();
    t.store.down = true;
    t.store.failWith = () => new Error('socket hang up at 10.9.8.7');
    await t.limiter.check(anonymous('203.0.113.7'));
    const warning = t.log.lines().find((l) => l['msg'] === 'ratelimit.store_unavailable');
    expect(warning?.['reason']).toBe('error');
    expect(t.log.raw()).not.toContain('10.9.8.7');
  });

  it('switches back to the store within STORE_RETRY_MS of it recovering', async () => {
    const t = setup();
    t.store.down = true;
    expect((await t.limiter.check(anonymous('203.0.113.7'))).degraded).toBe(true);
    t.store.down = false;
    // Still resting: the fallback answers.
    t.clock.advance(STORE_RETRY_MS - 1);
    expect((await t.limiter.check(anonymous('203.0.113.7'))).degraded).toBe(true);
    t.clock.advance(1);
    const back = await t.limiter.check(anonymous('203.0.113.7'));
    expect(back).toMatchObject({ allowed: true, degraded: false, limit: 30, remaining: 29 });
    expect(t.log.lines().filter((l) => l['msg'] === 'ratelimit.store_recovered')).toHaveLength(1);
    await t.limiter.check(anonymous('203.0.113.7'));
    expect(t.log.lines().filter((l) => l['msg'] === 'ratelimit.store_recovered')).toHaveLength(1);
  });

  it('works without a logger or metrics, and keeps blocks per process without a shared kv', async () => {
    const clock = new FakeClock();
    const store = flakyStore(createMemoryRedis(clock.read).rateLimit);
    const limiter = createRateLimiter({ store, config: testConfig(), clock: clock.read });
    store.down = true;
    const decisions = await checkTimes(limiter, 61, anonymous('203.0.113.7'));
    expect(allowedCount(decisions)).toBe(60);
    // Five overruns of the auth bucket block the address in this process.
    await checkTimes(limiter, 25, anonymous('198.51.100.9', { bucket: 'auth' }));
    expect(await limiter.check(anonymous('198.51.100.9'))).toMatchObject({
      allowed: false,
      blocked: true,
    });
  });

  it('refuses a configuration it cannot run with', () => {
    const clock = new FakeClock();
    expect(() =>
      createRateLimiter({
        store: createMemoryRedis(clock.read).rateLimit,
        config: testConfig({ trustedHops: 99 }),
      }),
    ).toThrow(RangeError);
  });

  it('blocks per process while the key-value store fails', async () => {
    const t = setup();
    t.kv.down = true;
    await checkTimes(t.limiter, 25, anonymous('203.0.113.7', { bucket: 'auth' }));
    expect(t.counters.count('ratelimit_blocks_total')).toBe(1);
    expect(await t.limiter.check(anonymous('203.0.113.7'))).toMatchObject({
      allowed: false,
      blocked: true,
      degraded: true,
      retryAfterS: 900,
    });
  });

  it('falls back for blocks on their own when only the key-value store fails', async () => {
    const t = setup();
    t.kv.down = true;
    const decision = await t.limiter.check(anonymous('203.0.113.7'));
    expect(decision).toMatchObject({ allowed: true, degraded: false, limit: 30 });
    expect(t.counters.count('ratelimit_store_errors_total')).toBe(1);
    const warning = t.log.lines().find((l) => l['msg'] === 'ratelimit.store_unavailable');
    expect(warning?.['store']).toBe('blocks');
    // The counters never failed, so nothing "recovers" when the blocks come back.
    t.kv.down = false;
    t.clock.advance(STORE_RETRY_MS);
    await t.limiter.check(anonymous('203.0.113.7'));
    const recovered = t.log.lines().filter((l) => l['msg'] === 'ratelimit.store_recovered');
    expect(recovered.map((l) => l['store'])).toEqual(['blocks']);
  });
});
