/** baseConfig: required keys, defaults, ranges, production TLS rules, shape and freezing. */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { baseConfig, ConfigError, Secret } from '../../src/index.js';

const DB = 'postgres://centcom:db-pass-81273@db.internal:5432/centcom';
const REDIS = 'redis://:redis-pass-55120@cache.internal:6379/0';
const VALID = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'api',
  PUBLIC_API_URL: 'http://localhost:3000',
  DATABASE_URL: DB,
  REDIS_URL: REDIS,
};
const PROD = {
  ...VALID,
  NODE_ENV: 'production',
  DATABASE_URL: `${DB}?sslmode=require`,
  REDIS_URL: REDIS.replace('redis://', 'rediss://'),
};

/** Enumerated keys: their allowed values are listed in messages by design, so they are not leak-checked. */
const ENUMERATED = new Set(['NODE_ENV', 'LOG_LEVEL']);

function issues(env: Record<string, string | undefined>): Array<{ key: string; problem: string }> {
  try {
    baseConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const err = e as ConfigError;
    const surfaces = `${err.message}${inspect(err)}${JSON.stringify(err)}`;
    for (const [key, value] of Object.entries(env)) {
      if (!ENUMERATED.has(key) && value && value.length >= 4)
        expect(surfaces, `${key} leaked`).not.toContain(value);
    }
    return [...err.issues];
  }
  throw new Error('expected a ConfigError');
}

describe('baseConfig', () => {
  it('returns the documented shape with defaults', () => {
    const c = baseConfig(VALID);
    expect(c).toEqual({
      nodeEnv: 'test',
      serviceName: 'api',
      logLevel: 'info',
      host: '127.0.0.1',
      port: 3000,
      publicApiUrl: 'http://localhost:3000',
      databaseUrl: expect.any(Secret),
      redisUrl: expect.any(Secret),
      trustedProxyHops: 1,
      requestTimeoutMs: 30000,
      allowInsecureBackends: false,
    });
    expect(c.databaseUrl.reveal()).toBe(DB);
    expect(c.redisUrl.reveal()).toBe(REDIS);
    expect(JSON.stringify(c)).not.toMatch(/db-pass|redis-pass/);
  });

  it('a missing DATABASE_URL is a ConfigError that names it and shows no value', () => {
    expect(issues({ ...VALID, DATABASE_URL: undefined })).toEqual([
      { key: 'DATABASE_URL', problem: 'is required' },
    ]);
  });

  it('NODE_ENV is required and unknown values are rejected (never treated as development)', () => {
    expect(issues({ ...VALID, NODE_ENV: undefined })).toEqual([
      { key: 'NODE_ENV', problem: 'is required' },
    ]);
    expect(issues({ ...VALID, NODE_ENV: 'prod' })).toEqual([
      { key: 'NODE_ENV', problem: 'must be one of: development, test, production' },
    ]);
    expect(issues({ ...VALID, NODE_ENV: 'Production' })[0]?.key).toBe('NODE_ENV');
  });

  it('applies the documented defaults and accepts overrides', () => {
    const c = baseConfig({
      ...VALID,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      REQUEST_TIMEOUT_MS: '5000',
      TRUSTED_PROXY_HOPS: '0',
      HOST: '0.0.0.0',
    });
    expect(c).toMatchObject({
      port: 8080,
      logLevel: 'debug',
      requestTimeoutMs: 5000,
      trustedProxyHops: 0,
      host: '0.0.0.0',
    });
  });

  it.each([
    ['0', 'must be at least 1'],
    ['70000', 'must be at most 65535'],
    ['80a', 'must be a whole number'],
  ])('rejects PORT=%s', (port, problem) => {
    expect(issues({ ...VALID, PORT: port })).toEqual([{ key: 'PORT', problem }]);
  });

  it('validates the other keys', () => {
    expect(
      issues({
        ...VALID,
        SERVICE_NAME: 'API Server',
        LOG_LEVEL: 'verbose',
        PUBLIC_API_URL: 'ftp://files.example',
        REDIS_URL: 'http://cache.internal',
        TRUSTED_PROXY_HOPS: '11',
        REQUEST_TIMEOUT_MS: '50',
        ALLOW_INSECURE_BACKENDS: 'yes',
      }).map((i) => i.key),
    ).toEqual([
      'SERVICE_NAME',
      'LOG_LEVEL',
      'PUBLIC_API_URL',
      'REDIS_URL',
      'TRUSTED_PROXY_HOPS',
      'REQUEST_TIMEOUT_MS',
      'ALLOW_INSECURE_BACKENDS',
    ]);
  });

  it('normalises PUBLIC_API_URL and refuses credentials in it', () => {
    expect(baseConfig({ ...VALID, PUBLIC_API_URL: 'https://api.centcom.dev/' }).publicApiUrl).toBe(
      'https://api.centcom.dev',
    );
    expect(issues({ ...VALID, PUBLIC_API_URL: 'https://u:p@api.centcom.dev' })[0]?.key).toBe(
      'PUBLIC_API_URL',
    );
  });

  it('is deep-frozen; assigning throws in strict mode', () => {
    const c = baseConfig(VALID) as { port: number };
    expect(() => {
      c.port = 1;
    }).toThrow(TypeError);
  });
});

describe('production TLS rules', () => {
  it('accepts sslmode=require (or verify-ca, verify-full) and rediss://', () => {
    expect(baseConfig(PROD).nodeEnv).toBe('production');
    for (const mode of ['verify-ca', 'verify-full']) {
      expect(baseConfig({ ...PROD, DATABASE_URL: `${DB}?sslmode=${mode}` }).nodeEnv).toBe(
        'production',
      );
    }
  });

  it('rejects a DATABASE_URL without sslmode=require and a redis:// REDIS_URL, together', () => {
    expect(issues({ ...PROD, DATABASE_URL: DB, REDIS_URL: REDIS })).toEqual([
      {
        key: 'DATABASE_URL',
        problem:
          'must set exactly one sslmode, require (or verify-ca, verify-full), in production; ALLOW_INSECURE_BACKENDS=1 overrides',
      },
      {
        key: 'REDIS_URL',
        problem: 'must use rediss:// (TLS) in production; ALLOW_INSECURE_BACKENDS=1 overrides',
      },
    ]);
    expect(issues({ ...PROD, DATABASE_URL: `${DB}?sslmode=disable` }).map((i) => i.key)).toEqual([
      'DATABASE_URL',
    ]);
  });

  // Review of B004: pg-connection-string copies query parameters in order, so the last sslmode
  // wins; a check that read the first one let `?sslmode=require&sslmode=disable` through.
  it.each([
    ['require then disable', 'sslmode=require&sslmode=disable'],
    ['disable then require', 'sslmode=disable&sslmode=require'],
    ['require twice', 'sslmode=require&sslmode=require'],
    ['an empty value', 'sslmode='],
    ['a different case', 'sslmode=Require'],
    ['no-verify', 'sslmode=no-verify'],
  ])('rejects a repeated or non-TLS sslmode (%s)', (_, query) => {
    expect(issues({ ...PROD, DATABASE_URL: `${DB}?${query}` }).map((i) => i.key)).toEqual([
      'DATABASE_URL',
    ]);
  });

  it('accepts exactly one TLS sslmode next to other parameters', () => {
    const url = `${DB}?application_name=api&sslmode=verify-full&connect_timeout=5`;
    expect(baseConfig({ ...PROD, DATABASE_URL: url }).databaseUrl.reveal()).toBe(url);
  });

  it('still reports the TLS rules when an unrelated key is invalid', () => {
    expect(issues({ ...PROD, DATABASE_URL: DB, PORT: '0' }).map((i) => i.key)).toEqual([
      'PORT',
      'DATABASE_URL',
    ]);
  });

  it('ALLOW_INSECURE_BACKENDS=1 overrides both rules', () => {
    const c = baseConfig({
      ...PROD,
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      ALLOW_INSECURE_BACKENDS: '1',
    });
    expect(c.allowInsecureBackends).toBe(true);
  });

  it('the rules apply only in production', () => {
    expect(baseConfig({ ...VALID, NODE_ENV: 'development' }).nodeEnv).toBe('development');
  });
});
