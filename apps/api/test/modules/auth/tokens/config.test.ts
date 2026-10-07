/**
 * Signing-key configuration (B017): a key set is read from AUTH_SIGNING_KEYS / AUTH_SIGNING_KID
 * secrets, every key is checked, and without a key that can sign the API refuses to start
 * (failure mode); errors name the key, never its material.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  generateSigningJwk,
  loadTokenKeys,
  MAX_SIGNING_KEYS,
  parseSigningKeys,
} from '../../../../src/modules/auth/tokens/index.js';
import { publicOnly } from './helpers.js';

/** The ConfigError `fn` throws, as `{key, problem}` pairs. */
function issues(fn: () => unknown): { key: string; problem: string }[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return [...err.issues];
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('parseSigningKeys', () => {
  it('accepts a set with a signing key and published-only keys, the active one first', () => {
    const active = generateSigningJwk('2026-10');
    const retired = publicOnly(generateSigningJwk('2026-07'));
    const keys = parseSigningKeys(JSON.stringify([retired, active]), '2026-10');
    expect(keys.active.kid).toBe('2026-10');
    expect(keys.active.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(keys.all.map((key) => [key.kid, key.privateKey !== undefined])).toEqual([
      ['2026-07', false],
      ['2026-10', true],
    ]);
  });

  it.each([
    ['not JSON', 'nope', /is not JSON/],
    ['an object', '{}', /JSON array of 1 to 10 keys/],
    ['empty', '[]', /JSON array of 1 to 10 keys/],
    [
      'too many',
      JSON.stringify(
        Array.from({ length: MAX_SIGNING_KEYS + 1 }, (_, i) => generateSigningJwk(`k${i}`)),
      ),
      /1 to 10/,
    ],
    ['RSA', JSON.stringify([{ kty: 'RSA', kid: 'k1', n: 'x', e: 'AQAB' }]), /not an Ed25519 JWK/],
    [
      'X25519',
      JSON.stringify([{ ...generateSigningJwk('k1'), crv: 'X25519' }]),
      /not an Ed25519 JWK/,
    ],
    ['no kid', JSON.stringify([{ ...generateSigningJwk('k1'), kid: undefined }]), /needs a kid/],
    ['a bad kid', JSON.stringify([generateSigningJwk('k 1')]), /needs a kid/],
    [
      'a repeated kid',
      JSON.stringify([generateSigningJwk('k1'), generateSigningJwk('k1')]),
      /kid k1 appears twice/,
    ],
    ['a short x', JSON.stringify([{ ...generateSigningJwk('k1'), x: 'abc' }]), /needs x/],
    ['a malformed d', JSON.stringify([{ ...generateSigningJwk('k1'), d: 42 }]), /malformed d/],
    [
      'a d of another key',
      JSON.stringify([{ ...generateSigningJwk('k1'), d: generateSigningJwk('k2').d }]),
      /d is not the private half of x/,
    ],
  ])('refuses %s, naming AUTH_SIGNING_KEYS and never the key material', (_label, json, problem) => {
    const found = issues(() => parseSigningKeys(json, 'k1'));
    expect(found).toEqual([
      { key: 'AUTH_SIGNING_KEYS', problem: expect.stringMatching(problem) as string },
    ]);
    const material = JSON.parse(json.startsWith('[') ? json : '[]') as {
      d?: unknown;
      x?: unknown;
    }[];
    for (const key of material) {
      if (typeof key.d === 'string') expect(found[0]?.problem).not.toContain(key.d);
    }
  });

  it('refuses an active kid that is missing, or whose key cannot sign (failure mode: no signing key)', () => {
    const jwk = generateSigningJwk('k1');
    expect(issues(() => parseSigningKeys(JSON.stringify([jwk]), 'k2'))).toEqual([
      { key: 'AUTH_SIGNING_KID', problem: 'names no key of AUTH_SIGNING_KEYS' },
    ]);
    expect(issues(() => parseSigningKeys(JSON.stringify([publicOnly(jwk)]), 'k1'))).toEqual([
      { key: 'AUTH_SIGNING_KID', problem: 'names a key without its private part (d)' },
    ]);
  });
});

describe('loadTokenKeys', () => {
  it('stops the start when the keys are not configured (failure mode: signing key missing at boot)', () => {
    expect(
      issues(() => loadTokenKeys({}))
        .map((issue) => issue.key)
        .sort(),
    ).toEqual(['AUTH_SIGNING_KEYS', 'AUTH_SIGNING_KID']);
  });

  it('reads the keys from the environment it is given, and keeps them out of the config error and its own printing', () => {
    const jwk = generateSigningJwk('k1');
    const keys = loadTokenKeys({
      AUTH_SIGNING_KEYS: JSON.stringify([jwk]),
      AUTH_SIGNING_KID: 'k1',
    });
    expect(keys.active.kid).toBe('k1');
    const err = (() => {
      try {
        loadTokenKeys({ AUTH_SIGNING_KEYS: JSON.stringify([jwk]), AUTH_SIGNING_KID: 'missing' });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(String(err?.message)).not.toContain(jwk.d);
  });
});
