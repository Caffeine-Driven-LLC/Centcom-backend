/**
 * The JWKS and key rotation (B017 acceptance 2, card test jwks.test.ts): only public Ed25519 keys
 * are published, at least two during an overlap, a token signed by the previous key still
 * verifies, and `GET /.well-known/jwks.json` serves it publicly with a 300 s cache.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  generateSigningJwk,
  publicJwks,
  signAccessToken,
  verifyAccessJwt,
} from '../../../../src/modules/auth/tokens/index.js';
import { authApp, keySet, memoryTokens, newId, publicOnly, T0 } from './helpers.js';

const claims = { sub: newId('usr'), scp: 'profile', plan: 'free', ent: 0 } as const;

describe('the JWKS', () => {
  it('holds only OKP/Ed25519 public keys: no d, active key first (acceptance 2)', () => {
    const old = generateSigningJwk('2026-07');
    const current = generateSigningJwk('2026-10');
    const next = generateSigningJwk('2027-01');
    const keys = keySet([old, current, next], '2026-10');
    const jwks = publicJwks(keys);
    expect(validate('api/Jwks', jwks).ok).toBe(true);
    expect(jwks.keys.map((key) => key.kid)).toEqual(['2026-10', '2026-07', '2027-01']);
    for (const key of jwks.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
      expect(key).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
    }
    const text = JSON.stringify(jwks);
    for (const jwk of [old, current, next]) expect(text).not.toContain(jwk.d);
  });

  it('keeps tokens of the previous key valid through a rotation, with both keys published (acceptance 2)', async () => {
    const previous = generateSigningJwk('k-prev');
    const next = generateSigningJwk('k-next');
    // Before: the previous key signs. Step 1: the next key is published, not yet active.
    const before = keySet([previous, next], 'k-prev');
    const { token } = await signAccessToken(before, claims, T0);
    // Step 2: the next key signs; the previous one stays published (here already without d).
    const after = keySet([next, publicOnly(previous)], 'k-next');
    expect(publicJwks(after).keys).toHaveLength(2);
    expect((await verifyAccessJwt(after, token, T0)).sub).toBe(claims.sub);
    const fresh = await signAccessToken(after, claims, T0);
    expect(
      JSON.parse(Buffer.from(fresh.token.split('.')[0] ?? '', 'base64url').toString()),
    ).toMatchObject({ kid: 'k-next' });
    // Step 3: the previous key is dropped once its tokens expired; its tokens stop verifying.
    const later = keySet([next], 'k-next');
    await expect(verifyAccessJwt(later, token, T0)).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('is served at /.well-known/jwks.json without authentication, cacheable for 300 s', async () => {
    const { tokens } = memoryTokens();
    const { app } = await authApp(tokens);
    const res = await app.inject({ url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json()).toEqual(tokens.jwks());
    await app.close();
  });
});
