/**
 * Device public keys (B016, CT-CRYPTO): the X25519 key that wraps session keys and the Ed25519 key
 * that signs frames, each 32 raw bytes sent as base64url without padding; and the fingerprint
 * users compare out of band: the first 12 characters of base32(BLAKE2b-256(X25519 ‖ Ed25519)),
 * shown as `ABCD-EFGH-IJKL` (CT-CRYPTO §1).
 *
 * Owns: checking a key's encoding and computing fingerprints. Must not: accept a key that does
 * not round-trip to exactly 32 bytes, or an all-zero key.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import type { FieldError } from '@centcom/core';

/** Raw bytes in a device public key. */
export const DEVICE_KEY_BYTES = 32;
/** How a key is sent: 32 bytes are 43 base64url characters without padding. */
export const DEVICE_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The two keys every device registers. */
export type DeviceKeyKind = 'x25519' | 'ed25519';
export const DEVICE_KEY_KINDS: readonly DeviceKeyKind[] = ['x25519', 'ed25519'];

/** A device's public keys, checked. */
export interface DevicePublicKeys {
  x25519: string;
  ed25519: string;
}

/** Details of the `errors[]` entries (CT-ERR: fixed English, never the value sent). */
const KEY_DETAILS = {
  required: 'is required',
  invalid_type: 'must be a string',
  invalid_format: 'must be 32 bytes, base64url without padding',
  invalid_value: 'must not be all zero',
} as const;

/** What is wrong with one key, or undefined when it is a usable 32-byte key. */
export function checkPublicKey(value: unknown): keyof typeof KEY_DETAILS | undefined {
  if (value === undefined) return 'required';
  if (typeof value !== 'string') return 'invalid_type';
  if (!DEVICE_KEY_SHAPE.test(value)) return 'invalid_format';
  const raw = Buffer.from(value, 'base64url');
  // 43 characters hold 258 bits: the last character's two spare bits must be zero (canonical).
  if (raw.length !== DEVICE_KEY_BYTES || raw.toString('base64url') !== value) {
    return 'invalid_format';
  }
  return raw.every((byte) => byte === 0) ? 'invalid_value' : undefined;
}

/**
 * Checks `device_pubkeys` of a request: the keys, or the field errors with JSON Pointers
 * (`/device_pubkeys`, `/device_pubkeys/x25519`, `/device_pubkeys/ed25519`).
 */
export function checkDevicePublicKeys(
  value: unknown,
  pointer = '/device_pubkeys',
): { keys: DevicePublicKeys } | { errors: FieldError[] } {
  if (value === undefined) {
    return { errors: [{ pointer, code: 'required', detail: KEY_DETAILS.required }] };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errors: [{ pointer, code: 'invalid_type', detail: 'must be an object' }] };
  }
  const record = value as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const kind of DEVICE_KEY_KINDS) {
    const problem = checkPublicKey(record[kind]);
    if (problem !== undefined) {
      errors.push({ pointer: `${pointer}/${kind}`, code: problem, detail: KEY_DETAILS[problem] });
    }
  }
  for (const key of Object.keys(record)) {
    if (!(DEVICE_KEY_KINDS as readonly string[]).includes(key)) {
      errors.push({
        pointer: `${pointer}/${escapePointer(key)}`,
        code: 'not_allowed',
        detail: 'is not a known key',
      });
    }
  }
  if (errors.length > 0) return { errors };
  return { keys: { x25519: record['x25519'] as string, ed25519: record['ed25519'] as string } };
}

/** RFC 6901 escaping of one pointer segment. */
const escapePointer = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

/** RFC 4648 base32 alphabet. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The first `chars` base32 characters of `bytes`. */
function base32Prefix(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
    if (out.length === chars) break;
  }
  return out;
}

/** CT-CRYPTO §1 fingerprint of two checked keys: `ABCD-EFGH-IJKL`. */
export function deviceFingerprint(keys: DevicePublicKeys): string {
  const digest = blake2b(
    Buffer.concat([Buffer.from(keys.x25519, 'base64url'), Buffer.from(keys.ed25519, 'base64url')]),
    { dkLen: 32 },
  );
  const fp = base32Prefix(digest, 12);
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}`;
}
