/**
 * User codes (B016, CT-AUTH): the 8 characters a person types on the verification page, from
 * A-Z and 2-9 without the look-alikes 0, O, 1, I and L (31 characters, about 39.6 bits), shown as
 * `ABCD-EFGH`. Stored and compared in the normalised form, without the hyphen.
 *
 * Owns: generating, formatting and normalising user codes. Must not: produce a character outside
 * the alphabet, or favour some characters over others (rejection sampling, no modulo bias).
 */
import { randomBytes } from 'node:crypto';

/** The CT-AUTH alphabet: `[A-Z2-9]` minus 0, O, 1, I, L. */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Characters in a user code. */
export const USER_CODE_LENGTH = 8;
/** A normalised user code. */
export const USER_CODE_SHAPE = /^[A-HJKMNP-Z2-9]{8}$/;
/** A user code as shown: `ABCD-EFGH`. */
export const FORMATTED_USER_CODE_SHAPE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

/** Random bytes, `randomBytes` by default; tests pass a seeded one. */
export type RandomSource = (size: number) => Uint8Array;

/** Bytes below this map evenly onto the alphabet (8 × 31); larger ones are drawn again. */
const UNBIASED_LIMIT = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;

/** A new user code in normalised form (8 characters, no hyphen). */
export function generateUserCode(rng: RandomSource = randomBytes): string {
  let code = '';
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of rng(USER_CODE_LENGTH * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (code.length === USER_CODE_LENGTH) break;
    }
  }
  return code;
}

/** `ABCDEFGH` as shown to people: `ABCD-EFGH`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a person typed, in normalised form: upper-cased, with spaces and one hyphen (between the
 * halves) allowed; null when it cannot be a user code.
 */
export function normaliseUserCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const compact = input.trim().toUpperCase().replace(/\s+/g, '');
  const code = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(compact) ? compact.replace('-', '') : compact;
  return USER_CODE_SHAPE.test(code) ? code : null;
}
