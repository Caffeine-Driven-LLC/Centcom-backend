/**
 * Buckets (B023, card test buckets.test.ts): the five default limits, the key each kind of caller
 * counts under (acceptance 2: users by id from any address, API keys by key id; acceptance 3:
 * auth by address; acceptance 4: usage by device), and the RATELIMIT_* overrides.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  checkRateLimitConfig,
  ConfigError,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  MAX_BUCKET_LIMIT,
  MAX_RATE_LIMIT,
  rateLimitConfig,
  UNKNOWN_IP,
  type RateLimitConfig,
} from '../../src/index.js';
import { aUser, anApiKey, testConfig } from './helpers.js';

describe('the default buckets', () => {
  it('are the five CT-PAGE buckets, per minute', () => {
    expect(defaultBuckets).toEqual({
      anonymous: { limit: 30, windowS: 60 },
      user: { limit: 600, windowS: 60 },
      apiKey: { limit: 1200, windowS: 60 },
      auth: { limit: 20, windowS: 60 },
      usage: { limit: 60, windowS: 60 },
    });
    expect(Object.isFrozen(defaultBuckets.user)).toBe(true);
    expect(DEFAULT_EXEMPT_ROUTES).toEqual(['/healthz', '/readyz']);
  });

  it('leave room for the fallback to double any limit within the store maximum', () => {
    expect(MAX_BUCKET_LIMIT * 2).toBe(MAX_RATE_LIMIT);
  });
});

describe('bucketKey', () => {
  it('counts anonymous callers by address, IPv6 by /64', () => {
    expect(bucketKey('default', null, '203.0.113.7')).toEqual({
      bucket: 'anonymous',
      key: 'rl:anonymous:203.0.113.7',
      ipKey: '203.0.113.7',
    });
    expect(bucketKey('default', null, '2001:db8:1:2::9').key).toBe(
      'rl:anonymous:2001:db8:1:2::/64',
    );
    expect(bucketKey('default', null, UNKNOWN_IP).key).toBe('rl:anonymous:unknown');
  });

  it('counts a user by id from any address, and an API key by key id (acceptance 2)', () => {
    const user = aUser({ device: true });
    const fromHome = bucketKey('default', user, '203.0.113.7');
    const fromWork = bucketKey('default', user, '198.51.100.9');
    expect(fromHome).toEqual({ bucket: 'user', key: `rl:user:${user.userId}` });
    expect(fromWork).toEqual(fromHome);
    const key = anApiKey();
    expect(bucketKey('default', key, '203.0.113.7')).toEqual({
      bucket: 'apiKey',
      key: `rl:apiKey:${key.kind === 'api_key' ? key.keyId : ''}`,
    });
  });

  it('counts the auth bucket by address, whoever calls (acceptance 3)', () => {
    for (const principal of [null, aUser(), anApiKey()]) {
      expect(bucketKey('auth', principal, '203.0.113.7')).toEqual({
        bucket: 'auth',
        key: 'rl:auth:203.0.113.7',
        ipKey: '203.0.113.7',
      });
    }
  });

  it('counts usage by device, else by user or API key, else by address (acceptance 4)', () => {
    const user = aUser({ device: true });
    expect(bucketKey('usage', user, '203.0.113.7')).toEqual({
      bucket: 'usage',
      key: `rl:usage:${user.deviceId ?? ''}`,
    });
    const deviceless = aUser();
    expect(bucketKey('usage', deviceless, '203.0.113.7').key).toBe(`rl:usage:${deviceless.userId}`);
    const key = anApiKey();
    expect(bucketKey('usage', key, '203.0.113.7').key).toBe(
      `rl:usage:${key.kind === 'api_key' ? key.keyId : ''}`,
    );
    expect(bucketKey('usage', null, '203.0.113.7')).toEqual({
      bucket: 'usage',
      key: 'rl:usage:ip:203.0.113.7',
      ipKey: '203.0.113.7',
    });
  });

  it('never builds a key from a malformed id', () => {
    const bad = [
      { kind: 'user', userId: 'usr_nope' },
      { kind: 'user', userId: newId('wsp') },
      { kind: 'user', userId: newId('usr'), deviceId: 'dev_../../x' },
      { kind: 'api_key', keyId: newId('usr') },
    ] as const;
    for (const principal of bad) {
      expect(() => bucketKey('usage', principal, '203.0.113.7')).toThrow(TypeError);
    }
  });
});

describe('rateLimitConfig', () => {
  it('defaults to the CT-PAGE buckets and takes the trusted hops from the base configuration', () => {
    const config = rateLimitConfig({ trustedProxyHops: 2 }, {});
    expect(config).toEqual({
      buckets: defaultBuckets,
      trustedHops: 2,
      exempt: ['/healthz', '/readyz'],
    });
    expect(Object.isFrozen(config.buckets.auth)).toBe(true);
  });

  it('takes every limit and the window from RATELIMIT_*', () => {
    const config = rateLimitConfig(
      { trustedProxyHops: 1 },
      {
        RATELIMIT_ANONYMOUS_LIMIT: '10',
        RATELIMIT_USER_LIMIT: '100',
        RATELIMIT_API_KEY_LIMIT: '5000',
        RATELIMIT_AUTH_LIMIT: '5',
        RATELIMIT_USAGE_LIMIT: '30',
        RATELIMIT_WINDOW_S: '120',
      },
    );
    expect(config.buckets).toEqual({
      anonymous: { limit: 10, windowS: 120 },
      user: { limit: 100, windowS: 120 },
      apiKey: { limit: 5000, windowS: 120 },
      auth: { limit: 5, windowS: 120 },
      usage: { limit: 30, windowS: 120 },
    });
  });

  it('refuses limits and windows out of range, by key name', () => {
    const env = {
      RATELIMIT_ANONYMOUS_LIMIT: '0',
      RATELIMIT_USER_LIMIT: '5001',
      RATELIMIT_AUTH_LIMIT: 'many',
      RATELIMIT_WINDOW_S: '5',
    };
    let error: unknown;
    try {
      rateLimitConfig({ trustedProxyHops: 1 }, env);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((i) => i.key).sort()).toEqual([
      'RATELIMIT_ANONYMOUS_LIMIT',
      'RATELIMIT_AUTH_LIMIT',
      'RATELIMIT_USER_LIMIT',
      'RATELIMIT_WINDOW_S',
    ]);
  });
});

describe('checkRateLimitConfig', () => {
  const withBucket = (bucket: object): RateLimitConfig =>
    testConfig({
      buckets: { ...defaultBuckets, auth: bucket as { limit: number; windowS: number } },
    });

  it('accepts the defaults', () => {
    expect(() => checkRateLimitConfig(testConfig())).not.toThrow();
  });

  it.each([
    [{ limit: 0, windowS: 60 }],
    [{ limit: MAX_BUCKET_LIMIT + 1, windowS: 60 }],
    [{ limit: 1.5, windowS: 60 }],
    [{ limit: 20, windowS: 0 }],
    [{ limit: 20, windowS: 3601 }],
    [{ limit: 20 }],
  ])('refuses the bucket %j', (bucket) => {
    expect(() => checkRateLimitConfig(withBucket(bucket))).toThrow(RangeError);
  });

  it('refuses a missing bucket, bad trusted hops and exempt entries that are not templates', () => {
    const withoutAuth: Partial<Record<keyof typeof defaultBuckets, object>> = { ...defaultBuckets };
    delete withoutAuth.auth;
    expect(() =>
      checkRateLimitConfig(testConfig({ buckets: withoutAuth as typeof defaultBuckets })),
    ).toThrow(RangeError);
    expect(() => checkRateLimitConfig(testConfig({ trustedHops: 11 }))).toThrow(RangeError);
    expect(() => checkRateLimitConfig(testConfig({ trustedHops: -1 }))).toThrow(RangeError);
    expect(() => checkRateLimitConfig(testConfig({ exempt: ['healthz'] }))).toThrow(TypeError);
    expect(() =>
      checkRateLimitConfig(testConfig({ exempt: '/healthz' as unknown as string[] })),
    ).toThrow(TypeError);
  });
});
