/**
 * API key material (B019, CT-AUTH): `cen_live_<32 base62>` or `cen_test_<32 base62>`, about 190
 * bits of CSPRNG output with no modulo bias (rejection sampling), its display prefix (the first
 * 12 characters) and its stored form, sha256(pepper ‖ key).
 *
 * Owns: making and hashing keys. Must not: log a key, or hash one without the pepper.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Secret } from '@centcom/core';
import type { ApiKeyMode } from '@centcom/db';

/** The base62 alphabet of a key's random part. */
export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Characters in a key's random part. */
export const API_KEY_RANDOM_CHARS = 32;
/** Characters of a key kept for display (`cen_live_Ab3`, CT-AUTH). */
export const API_KEY_PREFIX_CHARS = 12;
/** What a key looks like. */
export const API_KEY_SHAPE = /^cen_(live|test)_[0-9A-Za-z]{32}$/;
/** The bearer prefixes of keys, for the token service's resolver registry. */
export const API_KEY_PREFIXES = ['cen_live_', 'cen_test_'] as const;

/** Random bytes; tests pass a fixed source. */
export type RandomSource = (size: number) => Uint8Array;

/** Bytes below this map evenly onto base62 (4 × 62); larger ones are drawn again. */
const UNBIASED_LIMIT = Math.floor(256 / BASE62.length) * BASE62.length;

/** A new key and its display prefix. */
export function generateApiKey(
  mode: ApiKeyMode,
  rng: RandomSource = randomBytes,
): { key: string; prefix: string } {
  let random = '';
  while (random.length < API_KEY_RANDOM_CHARS) {
    for (const byte of rng(API_KEY_RANDOM_CHARS * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      random += BASE62[byte % BASE62.length];
      if (random.length === API_KEY_RANDOM_CHARS) break;
    }
  }
  const key = `cen_${mode}_${random}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_CHARS) };
}

/** The stored form of a key: sha256(pepper ‖ key), lower-case hex. */
export function hashApiKey(key: string, pepper: Secret<string>): string {
  return createHash('sha256').update(pepper.reveal(), 'utf8').update(key, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hashes of the same length. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
