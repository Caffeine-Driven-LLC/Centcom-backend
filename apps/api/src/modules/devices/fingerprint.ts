/**
 * Device key fingerprints (B020, CT-CRYPTO §1): what users compare out of band to trust a device's
 * keys. `fp` is the first 12 characters of base32 (RFC 4648) of BLAKE2b-256(X25519 ‖ Ed25519),
 * shown as `ABCD-EFGH-IJKL`.
 *
 * Owns: the fingerprint. Must not: accept keys that are not 32 bytes each.
 */
import { blake2b } from '@noble/hashes/blake2.js';

/** `ABCD-EFGH-IJKL`: three groups of four RFC 4648 base32 characters. */
export const FINGERPRINT_PATTERN = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

/** RFC 4648 base32 alphabet. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The first `chars` base32 characters of `bytes` (no padding needed: `bytes` is long enough). */
function base32Prefix(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += BASE32[(buffer >>> bits) & 31];
    }
    if (out.length === chars) break;
  }
  return out;
}

/** The CT-CRYPTO fingerprint of a device's raw X25519 and Ed25519 public keys. */
export function deviceFingerprint(x25519: Uint8Array, ed25519: Uint8Array): string {
  if (x25519.length !== 32 || ed25519.length !== 32) {
    throw new RangeError('deviceFingerprint: each key must be 32 bytes');
  }
  const input = new Uint8Array(64);
  input.set(x25519, 0);
  input.set(ed25519, 32);
  const fp = base32Prefix(blake2b(input, { dkLen: 32 }), 12);
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}`;
}
