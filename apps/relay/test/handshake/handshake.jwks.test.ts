/**
 * The JWKS cache (B038 acceptance 9, failure mode "JWKS unreachable"; tests
 * "handshake.jwks.test.ts"): one fetch serves 10 minutes; after that it refetches; a new `kid`
 * refetches at most once per 30 s, so 100 concurrent lookups of an unknown `kid` cost one fetch;
 * both keys of a rotation verify; an unreachable API keeps the last keys working for an hour after
 * their fetch, then lookups are 503; non-Ed25519 and malformed keys are skipped; the HTTP fetcher
 * takes only a 200 JSON answer.
 */
import { createServer } from 'node:http';
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  httpJwksFetcher,
  JWKS_COOLDOWN_MS,
  JWKS_MAX_STALE_MS,
  JWKS_TTL_MS,
  JwksCache,
  parseJwks,
  UnknownKidError,
} from '../../src/handshake/jwks.js';
import { signingKey, stubJwks } from './helpers.js';

function cacheWith(keys: object[]) {
  let now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const jwks = stubJwks(keys);
  const cache = new JwksCache({
    url: 'https://api.centcom.test/jwks',
    fetch: jwks.fetcher,
    clock: () => now,
  });
  return {
    cache,
    jwks,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'key',
    (err: unknown) =>
      err instanceof UnknownKidError ? 'unknown' : isAppError(err) ? String(err.status) : 'error',
  );

describe('JwksCache', () => {
  it('serves one fetch for 10 minutes, then refetches', async () => {
    const k1 = signingKey('k1');
    const { cache, jwks, advance } = cacheWith([k1.jwk]);
    await cache.key('k1');
    await cache.key('k1');
    expect(jwks.state.calls).toBe(1);
    advance(JWKS_TTL_MS - 1);
    await cache.key('k1');
    expect(jwks.state.calls).toBe(1);
    advance(1);
    await cache.key('k1');
    expect(jwks.state.calls).toBe(2);
  });

  it('refetches once for 100 concurrent lookups of an unknown kid, then waits 30 s', async () => {
    const k1 = signingKey('k1');
    const k2 = signingKey('k2');
    const { cache, jwks, advance } = cacheWith([k1.jwk]);
    await cache.key('k1');
    jwks.state.keys = [k1.jwk, k2.jwk];
    jwks.state.delayMs = 20;
    advance(JWKS_COOLDOWN_MS);
    const results = await Promise.all(Array.from({ length: 100 }, () => outcome(cache.key('k2'))));
    expect(new Set(results)).toEqual(new Set(['key']));
    expect(jwks.state.calls).toBe(2);
    // An unknown kid within the next 30 s does not fetch again.
    const misses = await Promise.all(Array.from({ length: 100 }, () => outcome(cache.key('k9'))));
    expect(new Set(misses)).toEqual(new Set(['unknown']));
    expect(jwks.state.calls).toBe(2);
    advance(JWKS_COOLDOWN_MS);
    expect(await outcome(cache.key('k9'))).toBe('unknown');
    expect(jwks.state.calls).toBe(3);
  });

  it('verifies with both keys of a rotation', async () => {
    const old = signingKey('old');
    const next = signingKey('new');
    const { cache } = cacheWith([old.jwk, next.jwk]);
    expect(await outcome(cache.key('old'))).toBe('key');
    expect(await outcome(cache.key('new'))).toBe('key');
  });

  it('keeps the last keys an hour after their fetch when the API is down, then answers 503', async () => {
    const k1 = signingKey('k1');
    const { cache, jwks, advance } = cacheWith([k1.jwk]);
    await cache.key('k1');
    jwks.state.fail = true;
    advance(JWKS_TTL_MS + 1);
    expect(await outcome(cache.key('k1'))).toBe('key');
    advance(JWKS_MAX_STALE_MS - JWKS_TTL_MS - 2);
    expect(await outcome(cache.key('k1'))).toBe('key');
    advance(JWKS_COOLDOWN_MS);
    expect(await outcome(cache.key('k1'))).toBe('503');
    jwks.state.fail = false;
    advance(JWKS_COOLDOWN_MS);
    expect(await outcome(cache.key('k1'))).toBe('key');
  });

  it('answers 503 when the first fetch fails, without fetching on every lookup', async () => {
    const { cache, jwks } = cacheWith([]);
    jwks.state.fail = true;
    expect(await outcome(cache.key('k1'))).toBe('503');
    expect(await outcome(cache.key('k1'))).toBe('503');
    expect(jwks.state.calls).toBe(1);
  });

  it('keeps the old keys when a fetch returns no usable key', async () => {
    const k1 = signingKey('k1');
    const { cache, jwks, advance } = cacheWith([k1.jwk]);
    await cache.key('k1');
    jwks.state.keys = [];
    advance(JWKS_TTL_MS);
    expect(await outcome(cache.key('k1'))).toBe('key');
  });
});

describe('parseJwks', () => {
  it('takes Ed25519 keys only and skips malformed ones', () => {
    const good = signingKey('good');
    const keys = parseJwks({
      keys: [
        good.jwk,
        { kty: 'RSA', kid: 'rsa', n: 'x', e: 'AQAB' },
        { kty: 'OKP', crv: 'X25519', kid: 'x', x: 'abc' },
        { kty: 'OKP', crv: 'Ed25519', kid: 'bad', x: '!!!' },
        { kty: 'OKP', crv: 'Ed25519', x: 'no-kid' },
        'nonsense',
      ],
    });
    expect([...keys.keys()]).toEqual(['good']);
    expect(parseJwks(null).size).toBe(0);
    expect(parseJwks({ keys: 'x' }).size).toBe(0);
  });
});

describe('httpJwksFetcher', () => {
  it('reads a 200 JSON answer and refuses anything else', async () => {
    let status = 200;
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"keys":[]}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/jwks`;
    try {
      expect(await httpJwksFetcher(url, AbortSignal.timeout(2000))).toEqual({ keys: [] });
      status = 500;
      await expect(httpJwksFetcher(url, AbortSignal.timeout(2000))).rejects.toThrow('500');
    } finally {
      server.close();
    }
  });
});
