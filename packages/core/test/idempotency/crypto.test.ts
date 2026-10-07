/**
 * Encryption of stored responses (B024, card test crypto.test.ts): round trips, tamper detection
 * (data, tag, IV, key, store key), malformed input, and IDEMPOTENCY_ENCRYPTION_KEY.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  idempotencyConfig,
  openBody,
  sealBody,
  Secret,
  type SealedBody,
} from '../../src/index.js';
import { newKey } from './helpers.js';

/** A value that must never appear in a sealed record, made at run time. */
const MARKER = randomBytes(12).toString('hex');
const BODY = Buffer.from(JSON.stringify({ created: MARKER }), 'utf8');
const STORE_KEY = 'idem:one';

/** `sealed` with one base64 field changed in its first byte. */
const flip = (sealed: SealedBody, field: keyof SealedBody): SealedBody => {
  const bytes = Buffer.from(sealed[field], 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return { ...sealed, [field]: bytes.toString('base64') };
};

describe('sealBody and openBody', () => {
  it('open what they sealed, with a fresh IV every time and no plaintext in the record', () => {
    const key = newKey();
    const first = sealBody(key, BODY, STORE_KEY);
    const second = sealBody(key, BODY, STORE_KEY);
    expect(openBody(key, first, STORE_KEY).equals(BODY)).toBe(true);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
    expect(JSON.stringify(first)).not.toContain(MARKER);
    expect(Buffer.from(first.data, 'base64').toString('utf8')).not.toContain(MARKER);
    expect(openBody(key, sealBody(key, Buffer.alloc(0), STORE_KEY), STORE_KEY)).toHaveLength(0);
  });

  it('detect tampering with the data, the tag or the IV', () => {
    const key = newKey();
    const sealed = sealBody(key, BODY, STORE_KEY);
    for (const field of ['data', 'tag', 'iv'] as const) {
      expect(() => openBody(key, flip(sealed, field), STORE_KEY)).toThrow();
    }
  });

  it('refuse another key, and a body moved to another store key', () => {
    const sealed = sealBody(newKey(), BODY, STORE_KEY);
    expect(() => openBody(newKey(), sealed, STORE_KEY)).toThrow();
    const key = newKey();
    expect(() => openBody(key, sealBody(key, BODY, STORE_KEY), 'idem:two')).toThrow();
  });

  it('refuse malformed sealed bodies and keys of the wrong size', () => {
    const key = newKey();
    const sealed = sealBody(key, BODY, STORE_KEY);
    expect(() => openBody(key, { ...sealed, iv: 'AAAA' }, STORE_KEY)).toThrow(/malformed/);
    expect(() => openBody(key, { ...sealed, tag: '' }, STORE_KEY)).toThrow(/malformed/);
    const short = new Secret(new Uint8Array(16));
    expect(() => sealBody(short, BODY, STORE_KEY)).toThrow(TypeError);
    expect(() => openBody(short, sealed, STORE_KEY)).toThrow(TypeError);
  });
});

describe('idempotencyConfig', () => {
  it('has no key when IDEMPOTENCY_ENCRYPTION_KEY is unset or blank', () => {
    expect(idempotencyConfig({})).toEqual({});
    expect(idempotencyConfig({ IDEMPOTENCY_ENCRYPTION_KEY: '' })).toEqual({});
  });

  it('reads a base64 32-byte key into a Secret', () => {
    const raw = randomBytes(32);
    const { encryptionKey } = idempotencyConfig({
      IDEMPOTENCY_ENCRYPTION_KEY: raw.toString('base64'),
    });
    expect(encryptionKey).toBeInstanceOf(Secret);
    expect(Buffer.from(encryptionKey?.reveal() ?? []).equals(raw)).toBe(true);
    expect(String(encryptionKey)).toBe('[redacted]');
  });

  it.each([
    ['not base64', 'not base64!'],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
  ])('refuses a key that is %s, naming the key but not the value', (_name, value) => {
    let error: unknown;
    try {
      idempotencyConfig({ IDEMPOTENCY_ENCRYPTION_KEY: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((i) => i.key)).toEqual(['IDEMPOTENCY_ENCRYPTION_KEY']);
    expect((error as ConfigError).message).not.toContain(value);
  });
});
