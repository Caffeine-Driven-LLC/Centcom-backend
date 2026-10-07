/**
 * Signing keys (B017): the public JWKS (`GET /.well-known/jwks.json`) built from the configured key
 * set, the verification key for a token's `kid`, and a key generator for operators and tests.
 *
 * Owns: what is published. Must not: publish anything but the public half (`x`) of each key.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Api } from '@centcom/contracts';
import type { SigningKey, TokenKeys } from './config.js';

/** One published key (CT-STATUS `Jwks`). */
export type PublicJwk = Api.Jwks['keys'][number];

/** The JWKS: the public half of every configured key, the active one first. */
export function publicJwks(keys: TokenKeys): Api.Jwks {
  const ordered = [keys.active, ...keys.all.filter((key) => key.kid !== keys.active.kid)];
  return {
    keys: ordered.map((key): PublicJwk => ({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: key.kid,
      use: 'sig',
      alg: 'EdDSA',
      x: key.x,
    })),
  };
}

/** The public key published under `kid`, if any. */
export function verificationKey(keys: TokenKeys, kid: unknown): KeyObject | undefined {
  return typeof kid === 'string' ? keys.all.find((key) => key.kid === kid)?.publicKey : undefined;
}

/**
 * A new Ed25519 key as a private JWK for AUTH_SIGNING_KEYS (`{kty, crv, kid, x, d}`). Keep the
 * result secret: it holds `d`.
 */
export function generateSigningJwk(kid: string): {
  kty: 'OKP';
  crv: 'Ed25519';
  kid: string;
  x: string;
  d: string;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { kty: 'OKP', crv: 'Ed25519', kid, x: String(jwk.x), d: String(jwk.d) };
}

/** True if `key` can sign. */
export const canSign = (key: SigningKey): boolean => key.privateKey !== undefined;
