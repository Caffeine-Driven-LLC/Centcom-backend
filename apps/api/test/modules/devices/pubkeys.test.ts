/**
 * Public key checks (B020 acceptance 4; tests "pubkeys.test.ts"): a table of good and bad keys
 * (31 and 33 bytes, characters outside base64url, padding, a non-canonical last character, all
 * zero, not a string, missing), and `registerDevice` naming every offending field in
 * `errors[].pointer` with a fixed detail that never echoes the key.
 */
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { checkPublicKeys, decodePublicKey } from '../../../src/modules/devices/pubkeys.js';
import { devicesApp, newId, randomKey } from './helpers.js';

const b64 = (bytes: Buffer): string => bytes.toString('base64url');
const GOOD = randomKey();

describe('decodePublicKey', () => {
  it.each([
    ['a random 32-byte key', GOOD, undefined],
    ['31 bytes', b64(Buffer.alloc(31, 1)), 'invalid_format'],
    ['33 bytes', b64(Buffer.alloc(33, 1)), 'invalid_format'],
    ['standard base64 (+ and /)', `${'+/'.repeat(21)}A`, 'invalid_format'],
    ['padding', `${GOOD}=`, 'invalid_format'],
    ['a space', ` ${GOOD.slice(1)}`, 'invalid_format'],
    ['a non-canonical last character', `${GOOD.slice(0, 42)}B`, 'invalid_format'],
    ['all zero', b64(Buffer.alloc(32)), 'invalid_value'],
    ['an empty string', '', 'invalid_format'],
    ['a number', 42, 'invalid_type'],
    ['nothing', undefined, 'required'],
  ])('%s', (_case, value, problem) => {
    const result = decodePublicKey(value);
    if (problem === undefined) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(Buffer.from(result.bytes).toString('base64url')).toBe(GOOD);
    } else {
      expect(result).toEqual({ ok: false, problem });
    }
  });

  it('accepts only the canonical last character of 32 bytes', () => {
    // The last character carries 4 bits of key and 2 spare bits: 1111 00 is '8', 1111 01 is '9'.
    const key = b64(Buffer.alloc(32, 0xff));
    expect(key.at(-1)).toBe('8');
    expect(decodePublicKey(key).ok).toBe(true);
    const sibling = `${key.slice(0, 42)}9`;
    expect(Buffer.from(sibling, 'base64url').equals(Buffer.alloc(32, 0xff))).toBe(true);
    expect(decodePublicKey(sibling)).toEqual({ ok: false, problem: 'invalid_format' });
  });
});

describe('checkPublicKeys', () => {
  it('names each bad key by pointer', () => {
    const result = checkPublicKeys({ x25519: b64(Buffer.alloc(31, 1)), ed25519: 7 }, '/keys');
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          pointer: '/keys/x25519',
          code: 'invalid_format',
          detail: 'must be 32 bytes, base64url without padding',
        },
        { pointer: '/keys/ed25519', code: 'invalid_type', detail: 'must be a string' },
      ],
    });
  });
});

describe('registerDevice', () => {
  const zero = b64(Buffer.alloc(32));

  it.each([
    ['x25519 of 31 bytes', { x25519: b64(Buffer.alloc(31, 1)) }, ['/x25519']],
    ['ed25519 of 33 bytes', { ed25519: b64(Buffer.alloc(33, 1)) }, ['/ed25519']],
    ['x25519 not base64url', { x25519: `${'*'.repeat(43)}` }, ['/x25519']],
    ['an all-zero ed25519', { ed25519: zero }, ['/ed25519']],
    ['both bad', { x25519: zero, ed25519: 'nope' }, ['/x25519', '/ed25519']],
    ['an empty name', { name: '   ' }, ['/name']],
    ['a name too long', { name: 'n'.repeat(81) }, ['/name']],
    ['an unknown platform', { platform: 'beos' }, ['/platform']],
    ['a bad user id', { userId: 'usr_nope' }, ['/userId']],
  ])('refuses %s with 422 naming the field', async (_case, overrides, pointers) => {
    const h = await devicesApp();
    const input = {
      userId: newId('usr'),
      name: 'Laptop',
      platform: 'linux',
      x25519: randomKey(),
      ed25519: randomKey(),
      ...overrides,
    };
    const error = await h.devices.registerDevice(input).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAppError(error) && error.code).toBe('validation_failed');
    const errors = isAppError(error) ? (error.errors ?? []) : [];
    expect(errors.map((e) => e.pointer)).toEqual(pointers);
    const body = JSON.stringify(errors);
    if (typeof input.x25519 === 'string' && input.x25519.length > 10) {
      expect(body).not.toContain(input.x25519);
    }
    expect(h.memory.rows.size).toBe(0);
    await h.app.close();
  });

  it('registers a device with its fingerprint, keys kept as given', async () => {
    const h = await devicesApp();
    const userId = newId('usr');
    const x25519 = b64(Buffer.alloc(32, 1));
    const ed25519 = b64(Buffer.alloc(32, 2));
    const device = await h.devices.registerDevice({
      userId,
      name: '  Work laptop ',
      platform: 'macos',
      x25519,
      ed25519,
    });
    expect(device).toMatchObject({
      name: 'Work laptop',
      platform: 'macos',
      key_fingerprint: 'GC3A-B6Y7-BTAL',
      last_seen_at: null,
      revoked_at: null,
    });
    expect(device.id).toMatch(/^dev_/);
    expect(h.memory.rows.get(device.id)).toMatchObject({
      user_id: userId,
      x25519_pub: x25519,
      ed25519_pub: ed25519,
    });
    await h.app.close();
  });
});
