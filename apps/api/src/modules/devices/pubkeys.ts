/**
 * Device public keys (B020, CT-CRYPTO): an X25519 key (wraps session keys) and an Ed25519 key
 * (signs frames), each 32 raw bytes sent as base64url without padding (43 characters). A key must
 * decode to exactly 32 bytes in its canonical encoding and must not be all zero.
 *
 * Owns: checking keys. Must not: echo a key in an error (CT-ERR: fixed English details only).
 */
import type { FieldError } from '@centcom/core';

/** Raw bytes of a device public key. */
export const PUBLIC_KEY_BYTES = 32;
/** How a key is sent: 43 base64url characters, no padding. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The two keys a device registers. */
export const PUBLIC_KEY_FIELDS = ['x25519', 'ed25519'] as const;
export type PublicKeyField = (typeof PUBLIC_KEY_FIELDS)[number];

/** Why a key is refused, and the detail its `errors[]` entry carries. */
const PROBLEMS = {
  required: 'is required',
  invalid_type: 'must be a string',
  invalid_format: 'must be 32 bytes, base64url without padding',
  invalid_value: 'must not be all zero',
} as const;
export type PublicKeyProblem = keyof typeof PROBLEMS;

/** The raw bytes of a usable key, or why it is not one. */
export function decodePublicKey(
  value: unknown,
): { ok: true; bytes: Uint8Array } | { ok: false; problem: PublicKeyProblem } {
  if (value === undefined) return { ok: false, problem: 'required' };
  if (typeof value !== 'string') return { ok: false, problem: 'invalid_type' };
  if (!PUBLIC_KEY_PATTERN.test(value)) return { ok: false, problem: 'invalid_format' };
  const bytes = Buffer.from(value, 'base64url');
  // 43 characters carry 258 bits: the last character's 2 spare bits must be zero (canonical form).
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes.toString('base64url') !== value) {
    return { ok: false, problem: 'invalid_format' };
  }
  if (bytes.every((byte) => byte === 0)) return { ok: false, problem: 'invalid_value' };
  return { ok: true, bytes: new Uint8Array(bytes) };
}

/**
 * Checks both keys of `input`: their raw bytes, or one `errors[]` entry per bad key, pointing at
 * `${prefix}/x25519` or `${prefix}/ed25519`.
 */
export function checkPublicKeys(
  input: { x25519?: unknown; ed25519?: unknown },
  prefix = '',
): { ok: true; x25519: Uint8Array; ed25519: Uint8Array } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const decoded: Partial<Record<PublicKeyField, Uint8Array>> = {};
  for (const field of PUBLIC_KEY_FIELDS) {
    const result = decodePublicKey(input[field]);
    if (result.ok) decoded[field] = result.bytes;
    else
      errors.push({
        pointer: `${prefix}/${field}`,
        code: result.problem,
        detail: PROBLEMS[result.problem],
      });
  }
  const { x25519, ed25519 } = decoded;
  if (errors.length > 0 || x25519 === undefined || ed25519 === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, x25519, ed25519 };
}
