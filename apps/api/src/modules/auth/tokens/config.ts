/**
 * Token signing configuration (B017): the Ed25519 key set and which key signs, read through the
 * config loader (B004) from secrets only, never from the repository.
 *
 * `AUTH_SIGNING_KEYS` is a JSON array of Ed25519 JWKs, `{kty: "OKP", crv: "Ed25519", kid, x, d}`:
 * keys with `d` can sign, keys without it are published for verification only (a retired key
 * whose tokens may still be live). `AUTH_SIGNING_KID` names the key that signs new tokens; it
 * must be one with `d`. Rotation, at least every 90 days (CT-AUTH):
 *
 * 1. add the new key (with `d`) to AUTH_SIGNING_KEYS and deploy: it is published, not used;
 * 2. once JWKS caches have refreshed (`max-age` 300 s), point AUTH_SIGNING_KID at it and deploy;
 * 3. after the old key's last token expired (15 min), drop its `d`; later, drop it entirely.
 *
 * Owns: parsing and checking the keys. Must not: put a key in an error, or start without a key
 * that can sign (the API refuses to start: ConfigError).
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { ConfigError, defineConfig, secretString, z, type Env } from '@centcom/core';

/** The environment keys of the token service. */
export const tokenEnvSchema = z.object({
  AUTH_SIGNING_KEYS: secretString().meta({
    description:
      'Token signing keys: a JSON array of Ed25519 JWKs ({kty, crv, kid, x, d}). Keys without d are only published for verification.',
    example: '[{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"...","d":"..."}]',
  }),
  AUTH_SIGNING_KID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .meta({
      description:
        'kid of the key that signs new tokens; it must be in AUTH_SIGNING_KEYS with its private part (d).',
      example: 'k1',
    }),
});

/** The most keys a set may hold (published keys cost every verifier a lookup). */
export const MAX_SIGNING_KEYS = 10;

/** A key of the set. */
export interface SigningKey {
  kid: string;
  /** The public key, base64url (the JWK's `x`). */
  x: string;
  publicKey: KeyObject;
  /** Present when the key can sign. */
  privateKey?: KeyObject;
}

/** The checked key set. */
export interface TokenKeys {
  /** The key that signs; it has a private key. */
  readonly active: SigningKey & { privateKey: KeyObject };
  /** Every key, the active one included, in configuration order. */
  readonly all: readonly SigningKey[];
}

const KID = /^[A-Za-z0-9._-]{1,64}$/;
const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A ConfigError about AUTH_SIGNING_KEYS (`problem` never holds key material). */
const keysProblem = (problem: string): ConfigError =>
  new ConfigError([{ key: 'AUTH_SIGNING_KEYS', problem }]);

/**
 * Checks a key set: a JSON array of 1-10 Ed25519 JWKs with unique kids, each `x` a 32-byte key and
 * each `d` the private half of its `x`; `activeKid` names one with `d`. Throws ConfigError.
 */
export function parseSigningKeys(json: string, activeKid: string): TokenKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw keysProblem('is not JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SIGNING_KEYS) {
    throw keysProblem(`must be a JSON array of 1 to ${MAX_SIGNING_KEYS} keys`);
  }
  const all: SigningKey[] = [];
  for (const [i, jwk] of parsed.entries()) {
    if (!isRecord(jwk) || jwk['kty'] !== 'OKP' || jwk['crv'] !== 'Ed25519') {
      throw keysProblem(`key ${i + 1} is not an Ed25519 JWK (kty OKP, crv Ed25519)`);
    }
    const { kid, x, d } = jwk;
    if (typeof kid !== 'string' || !KID.test(kid))
      throw keysProblem(`key ${i + 1} needs a kid of 1-64 characters A-Z a-z 0-9 . _ -`);
    if (all.some((key) => key.kid === kid)) throw keysProblem(`kid ${kid} appears twice`);
    if (typeof x !== 'string' || !B64URL_32_BYTES.test(x))
      throw keysProblem(`key ${kid} needs x, a 32-byte public key`);
    if (d !== undefined && (typeof d !== 'string' || !B64URL_32_BYTES.test(d))) {
      throw keysProblem(`key ${kid} has a malformed d`);
    }
    let publicKey: KeyObject;
    let privateKey: KeyObject | undefined;
    try {
      publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      if (typeof d === 'string')
        privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x, d }, format: 'jwk' });
    } catch {
      throw keysProblem(`key ${kid} is not a valid Ed25519 key`);
    }
    // Node takes the public half from `d` and ignores `x`: a d that belongs to another x would sign
    // tokens the published key cannot verify.
    if (privateKey !== undefined && createPublicKey(privateKey).export({ format: 'jwk' }).x !== x) {
      throw keysProblem(`key ${kid}: d is not the private half of x`);
    }
    all.push({ kid, x, publicKey, ...(privateKey === undefined ? {} : { privateKey }) });
  }
  const active = all.find((key) => key.kid === activeKid);
  if (active === undefined) {
    throw new ConfigError([
      { key: 'AUTH_SIGNING_KID', problem: 'names no key of AUTH_SIGNING_KEYS' },
    ]);
  }
  if (active.privateKey === undefined) {
    throw new ConfigError([
      { key: 'AUTH_SIGNING_KID', problem: 'names a key without its private part (d)' },
    ]);
  }
  return { active: { ...active, privateKey: active.privateKey }, all };
}

/** Reads and checks the signing keys (default: the process environment, through the config loader). */
export function loadTokenKeys(env?: Env): TokenKeys {
  const config = defineConfig(tokenEnvSchema, env);
  return parseSigningKeys(config.AUTH_SIGNING_KEYS.reveal(), config.AUTH_SIGNING_KID);
}
