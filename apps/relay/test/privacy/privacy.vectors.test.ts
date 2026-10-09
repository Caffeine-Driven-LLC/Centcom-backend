/**
 * CT-CRYPTO known-answer vectors, relay side (B050; tests "privacy.vectors.test.ts"): the relay never
 * opens anything, so it checks structure only: the XChaCha20-Poly1305 nonce is 24 bytes, the
 * ciphertext is the plaintext plus a 16-byte tag, a signature is 64 bytes, a key is 32 bytes; as
 * base64url they match the envelope's patterns. Skipped with a message if the fixture is missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';

const VECTORS = new URL('../../../../contracts/fixtures/crypto/vectors.json', import.meta.url);
const present = existsSync(VECTORS);
const bytes = (b64url: string): number => Buffer.from(b64url, 'base64url').length;

describe.runIf(present)('crypto vectors: structure only', () => {
  const v = present
    ? (JSON.parse(readFileSync(VECTORS, 'utf8')) as {
        xchacha20poly1305: {
          key: string;
          nonce: string;
          plaintext_jcs: string;
          ciphertext: string;
          aad_header: Record<string, unknown>;
        };
        frame_signature: { signature: string };
        keys: Record<string, string>;
      })
    : undefined;

  it('nonce 24 bytes, ciphertext = plaintext + 16, signature 64, keys 32', () => {
    if (v === undefined) return;
    const x = v.xchacha20poly1305;
    expect(bytes(x.nonce)).toBe(24);
    expect(bytes(x.ciphertext)).toBe(Buffer.byteLength(x.plaintext_jcs, 'utf8') + 16);
    expect(bytes(v.frame_signature.signature)).toBe(64);
    for (const key of Object.values(v.keys)) expect(bytes(key)).toBe(32);
  });

  it('a frame built from the vectors passes the envelope (as the relay would carry it)', () => {
    if (v === undefined) return;
    const x = v.xchacha20poly1305;
    const frame = {
      ...x.aad_header,
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: x.nonce, c: x.ciphertext },
      sig: v.frame_signature.signature,
    };
    delete (frame as Record<string, unknown>)['from_dev'];
    delete (frame as Record<string, unknown>)['kid'];
    expect(validate('envelope', frame).ok).toBe(true);
  });
});

describe.skipIf(present)('crypto vectors', () => {
  it.skip('contracts/fixtures/crypto/vectors.json is not there yet: nothing to check', () =>
    undefined);
});
