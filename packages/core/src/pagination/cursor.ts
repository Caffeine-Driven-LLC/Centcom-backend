/**
 * Cursors (B025, CT-PAGE): opaque, URL-safe, signed, bound to the filters and sort they were made
 * for, and good for 24 hours. A cursor is `<key id>.<payload>.<signature>`: the payload is
 * base64url JSON `{v:1, k, f, s, exp}` (keyset values, filter hash, sort, expiry in Unix
 * seconds) and the signature is HMAC-SHA256 over `<key id>.<payload>`. The newest key signs; every
 * configured key verifies, so keys rotate without breaking cursors in flight.
 *
 * Owns: encoding, verifying and decoding cursors, and CURSOR_SIGNING_KEYS. Must not: read a
 * payload before its signature checks out, compare signatures in variable time, put anything but
 * keyset values in a payload, or fail with anything but a 400 `cursor_invalid`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { defineConfig, type Env } from '../config/define.js';
import { Secret } from '../config/secret.js';
import { MAX_CURSOR_LENGTH, cursorInvalid } from './query.js';

/** How long a cursor is good for. */
export const CURSOR_TTL_S = 24 * 60 * 60;
/** The shortest signing secret, in bytes. */
export const MIN_CURSOR_SECRET_BYTES = 32;
/** The most keyset values a cursor carries (a sort value and the id). */
export const MAX_KEYSET_VALUES = 2;
/** The longest keyset value, in characters. */
export const MAX_KEYSET_VALUE_LENGTH = 200;

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** One signing key. */
export interface SigningKey {
  readonly id: string;
  readonly secret: Secret<Uint8Array>;
}

/** Signing keys, newest first: the first signs, all verify. */
export type SigningKeys = readonly SigningKey[];

/** A keyset value: text as Postgres prints it, or a number (in-memory lists). */
export type KeysetValue = string | number;

/** What a cursor says. */
export interface CursorPayload {
  /** The keyset values of the last row of the page: its sort value, then its id. */
  readonly k: readonly KeysetValue[];
  /** The hash of the filters the cursor is bound to. */
  readonly f: string;
  /** The sort the cursor is bound to. */
  readonly s: string;
}

/** A verified cursor. */
export interface DecodedCursor extends CursorPayload {
  readonly v: 1;
  /** Expiry, Unix seconds. */
  readonly exp: number;
}

const sign = (key: SigningKey, signed: string): Buffer =>
  createHmac('sha256', key.secret.reveal()).update(signed, 'utf8').digest();

const isKeysetValue = (value: unknown): value is KeysetValue =>
  (typeof value === 'string' && value.length <= MAX_KEYSET_VALUE_LENGTH) ||
  (typeof value === 'number' && Number.isFinite(value));

/**
 * A cursor for `payload`, signed with the newest key and expiring CURSOR_TTL_S after `now`
 * (milliseconds). Throws a TypeError for no keys or a payload a cursor cannot carry.
 */
export function encodeCursor(payload: CursorPayload, keys: SigningKeys, now: number): string {
  const key = keys[0];
  if (key === undefined) throw new TypeError('encodeCursor: no signing key');
  if (
    !Array.isArray(payload.k) ||
    payload.k.length === 0 ||
    payload.k.length > MAX_KEYSET_VALUES ||
    !payload.k.every(isKeysetValue)
  ) {
    throw new TypeError(`encodeCursor: k must hold 1 to ${MAX_KEYSET_VALUES} keyset values`);
  }
  const body: DecodedCursor = {
    v: 1,
    k: [...payload.k],
    f: payload.f,
    s: payload.s,
    exp: Math.floor(now / 1000) + CURSOR_TTL_S,
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const signed = `${key.id}.${encoded}`;
  return `${signed}.${sign(key, signed).toString('base64url')}`;
}

/** The payload of a verified cursor, or undefined when its shape is wrong. */
function readPayload(encoded: string): DecodedCursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const k = p['k'];
  const valid =
    p['v'] === 1 &&
    Array.isArray(k) &&
    k.length > 0 &&
    k.length <= MAX_KEYSET_VALUES &&
    k.every(isKeysetValue) &&
    typeof p['f'] === 'string' &&
    typeof p['s'] === 'string' &&
    Number.isSafeInteger(p['exp']);
  return valid ? (value as DecodedCursor) : undefined;
}

/**
 * The payload of cursor `c`, checked: signed by one of `keys`, not expired at `now`
 * (milliseconds), and bound to `expect`'s filter hash and sort. Throws only a 400
 * `cursor_invalid` (`errors[0].code`: `invalid`, `expired` or `mismatch`).
 */
export function decodeCursor(
  c: string,
  keys: SigningKeys,
  now: number,
  expect: { filterHash: string; sort: string },
): DecodedCursor {
  if (typeof c !== 'string' || c.length > MAX_CURSOR_LENGTH) throw cursorInvalid();
  const parts = c.split('.');
  if (parts.length !== 3) throw cursorInvalid();
  const [keyId = '', encoded = '', signature = ''] = parts;
  if (!KEY_ID.test(keyId) || !BASE64URL.test(encoded) || !BASE64URL.test(signature)) {
    throw cursorInvalid();
  }
  const key = keys.find((candidate) => candidate.id === keyId);
  if (key === undefined) throw cursorInvalid();
  // Compared as text: base64url's spare bits would let two spellings decode to one signature.
  const expected = Buffer.from(sign(key, `${keyId}.${encoded}`).toString('base64url'), 'ascii');
  const given = Buffer.from(signature, 'ascii');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw cursorInvalid();
  }
  const payload = readPayload(encoded);
  if (payload === undefined) throw cursorInvalid();
  if (payload.exp * 1000 <= now) throw cursorInvalid('expired');
  if (payload.f !== expect.filterHash || payload.s !== expect.sort) {
    throw cursorInvalid('mismatch');
  }
  return payload;
}

/** `kid:secret` pairs, newest first; each secret at least 32 characters. */
const signingKeysSchema = z
  .string()
  .transform((value, ctx): SigningKey[] => {
    const keys: SigningKey[] = [];
    for (const entry of value.split(',')) {
      const colon = entry.indexOf(':');
      const id = colon === -1 ? '' : entry.slice(0, colon);
      const secret = colon === -1 ? '' : entry.slice(colon + 1);
      if (!KEY_ID.test(id)) {
        ctx.addIssue({ code: 'custom', message: 'each key must be <id>:<secret> with a short id' });
        return z.NEVER;
      }
      if (Buffer.byteLength(secret, 'utf8') < MIN_CURSOR_SECRET_BYTES) {
        ctx.addIssue({ code: 'custom', message: 'each secret must be at least 32 characters' });
        return z.NEVER;
      }
      if (keys.some((key) => key.id === id)) {
        ctx.addIssue({ code: 'custom', message: 'key ids must be unique' });
        return z.NEVER;
      }
      keys.push({ id, secret: new Secret(new Uint8Array(Buffer.from(secret, 'utf8'))) });
    }
    return keys;
  })
  .meta({
    description:
      'Keys that sign list cursors, newest first: `id:secret[,id:secret...]`, each secret at least 32 characters. The first signs, all verify; to rotate, put the new key first and drop the old one after 24 hours.',
    example: 'dev:change-me-to-at-least-32-random-characters',
    envType: 'id:secret list',
    secret: true,
  });

/** The pagination environment keys (rendered into docs/config.md and .env.example). */
export const paginationEnvSchema = z.object({ CURSOR_SIGNING_KEYS: signingKeysSchema });

/** Checked pagination settings. */
export interface PaginationConfig {
  readonly signingKeys: SigningKeys;
}

/**
 * Reads CURSOR_SIGNING_KEYS (default: the process environment, through the config loader). It is
 * required: a service that lists anything refuses to start without it.
 */
export function paginationConfig(env?: Env): PaginationConfig {
  return { signingKeys: defineConfig(paginationEnvSchema, env).CURSOR_SIGNING_KEYS };
}
