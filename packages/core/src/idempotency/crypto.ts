/**
 * Encryption of stored responses (B024): AES-256-GCM under a 32-byte key
 * (`IDEMPOTENCY_ENCRYPTION_KEY`, base64), a fresh 96-bit IV per record, and the record's store key
 * as associated data, so a sealed body opens only where it was stored. Routes flagged
 * `sensitiveResponse` (API key creation and the like) keep their bodies only in this form, so a
 * secret in a response never rests in Redis in plaintext.
 *
 * Owns: sealing and opening bodies, and the key's env entry. Must not: keep the key outside a
 * Secret, or return any part of a body that fails authentication.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineConfig, type Env } from '../config/define.js';
import { Secret } from '../config/secret.js';

/** The key length AES-256 needs. */
export const ENCRYPTION_KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A sealed body: IV, ciphertext and authentication tag, each base64. */
export interface SealedBody {
  iv: string;
  data: string;
  tag: string;
}

/** The key's bytes; a TypeError for a key of the wrong size. */
function keyBytes(key: Secret<Uint8Array>): Uint8Array {
  const bytes = key.reveal();
  if (!(bytes instanceof Uint8Array) || bytes.length !== ENCRYPTION_KEY_BYTES) {
    throw new TypeError(`the idempotency encryption key must be ${ENCRYPTION_KEY_BYTES} bytes`);
  }
  return bytes;
}

/** Encrypts `body`, bound to `aad` (the store key it is kept under). */
export function sealBody(key: Secret<Uint8Array>, body: Uint8Array, aad: string): SealedBody {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyBytes(key), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(body), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * The body `sealed` holds. Throws when it was altered, sealed under another key, or stored under
 * another store key (`aad`).
 */
export function openBody(key: Secret<Uint8Array>, sealed: SealedBody, aad: string): Buffer {
  const iv = Buffer.from(sealed.iv, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('openBody: the sealed body is malformed');
  }
  const decipher = createDecipheriv(ALGORITHM, keyBytes(key), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

/** The idempotency environment keys (rendered into docs/config.md and .env.example). */
export const idempotencyEnvSchema = z.object({
  IDEMPOTENCY_ENCRYPTION_KEY: z
    .string()
    .regex(BASE64, 'must be base64')
    .transform((value) => new Uint8Array(Buffer.from(value, 'base64')))
    .refine((bytes) => bytes.length === ENCRYPTION_KEY_BYTES, 'must decode to 32 bytes')
    .transform((bytes) => new Secret(bytes))
    .optional()
    .meta({
      description:
        'Key (32 bytes, base64; e.g. `openssl rand -base64 32`) that encrypts stored responses of sensitive routes. Without it, routes flagged sensitiveResponse refuse to start.',
      example: '',
      envType: 'base64 (32 bytes)',
      secret: true,
    }),
});

/** Checked idempotency settings. */
export interface IdempotencyConfig {
  /** Encrypts stored bodies of `sensitiveResponse` routes; absent when not configured. */
  encryptionKey?: Secret<Uint8Array>;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function idempotencyConfig(env?: Env): IdempotencyConfig {
  const key = defineConfig(idempotencyEnvSchema, env).IDEMPOTENCY_ENCRYPTION_KEY;
  return key === undefined ? {} : { encryptionKey: key as Secret<Uint8Array> };
}
