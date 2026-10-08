/**
 * Fingerprints (B020 acceptance 2; tests "fingerprint.test.ts"): CT-CRYPTO's BLAKE2b-256 form on
 * fixed bytes (checked against an independent computation), the `XXXX-XXXX-XXXX` base32 shape,
 * stability, sensitivity to either key and to their order, the 32-byte rule, and agreement with
 * the fingerprint B016's sign-in flow stores.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deviceFingerprint as signInFingerprint } from '../../../src/modules/auth/device/keys.js';
import {
  deviceFingerprint,
  FINGERPRINT_PATTERN,
} from '../../../src/modules/devices/fingerprint.js';

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('deviceFingerprint', () => {
  it('matches the CT-CRYPTO value for fixed key bytes', () => {
    // base32(BLAKE2b-256(0x01 * 32 ‖ 0x02 * 32))[0:12], computed with Python's hashlib.
    expect(deviceFingerprint(filled(1), filled(2))).toBe('GC3A-B6Y7-BTAL');
  });

  it('is XXXX-XXXX-XXXX in RFC 4648 base32 and the same on every call', () => {
    const x = filled(7);
    const e = filled(9);
    const first = deviceFingerprint(x, e);
    expect(first).toMatch(FINGERPRINT_PATTERN);
    expect(first).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    for (let i = 0; i < 5; i += 1) expect(deviceFingerprint(x, e)).toBe(first);
  });

  it('changes with either key and with their order', () => {
    const base = deviceFingerprint(filled(1), filled(2));
    expect(deviceFingerprint(filled(2), filled(1))).not.toBe(base);
    const x = filled(1);
    x[31] = 0;
    expect(deviceFingerprint(x, filled(2))).not.toBe(base);
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => deviceFingerprint(new Uint8Array(31), filled(1))).toThrow(RangeError);
    expect(() => deviceFingerprint(filled(1), new Uint8Array(33))).toThrow(RangeError);
  });

  it('agrees with the fingerprint the device sign-in (B016) stores', () => {
    const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
    fc.assert(
      fc.property(key, key, (x, e) => {
        const ours = deviceFingerprint(x, e);
        expect(ours).toMatch(FINGERPRINT_PATTERN);
        expect(
          signInFingerprint({
            x25519: Buffer.from(x).toString('base64url'),
            ed25519: Buffer.from(e).toString('base64url'),
          }),
        ).toBe(ours);
      }),
      { numRuns: 100 },
    );
  });
});
