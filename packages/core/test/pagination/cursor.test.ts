/**
 * Cursors (B025, card test cursor.test.ts): the codec, binding to filters and sort, expiry after
 * 24 h on a fake clock, tampering and forgery (acceptance 4 and 5), key rotation (acceptance 6),
 * and CURSOR_SIGNING_KEYS (a service refuses to start without it).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigError,
  CURSOR_TTL_S,
  decodeCursor,
  encodeCursor,
  paginationConfig,
  Secret,
} from '../../src/index.js';
import { BINDING, NOW, signingKey, signRaw } from './helpers.js';

const KEY = signingKey('k1');
const PAYLOAD = {
  k: ['2026-10-07 12:00:00.123456+00', 'itm_1'],
  f: BINDING.filterHash,
  s: BINDING.sort,
};

/** The `errors[0].code` of the cursor_invalid `fn` throws. */
function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: 'cursor_invalid', status: 400 });
    return (e as AppError).errors?.[0]?.code;
  }
  throw new Error('expected a cursor_invalid');
}

/** `cursor` with the character at `i` replaced by another of the same alphabet. */
const replaceAt = (cursor: string, i: number): string => {
  const c = cursor[i] ?? '';
  const swap = c === 'A' ? 'B' : c === '.' ? '-' : 'A';
  return cursor.slice(0, i) + swap + cursor.slice(i + 1);
};

describe('encodeCursor and decodeCursor', () => {
  it('round-trip, URL-safe, signed by the newest key, expiring in 24 hours', () => {
    const cursor = encodeCursor(PAYLOAD, [KEY], NOW);
    expect(cursor).toMatch(/^k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, [KEY], NOW, BINDING)).toEqual({
      v: 1,
      ...PAYLOAD,
      exp: NOW / 1000 + CURSOR_TTL_S,
    });
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('carry nothing but the keyset values, the binding and the expiry (acceptance 5)', () => {
    const [, payload = ''] = encodeCursor(PAYLOAD, [KEY], NOW).split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as object;
    expect(Object.keys(body).sort()).toEqual(['exp', 'f', 'k', 's', 'v']);
  });

  it('expire after 24 hours (acceptance 4)', () => {
    const cursor = encodeCursor(PAYLOAD, [KEY], NOW);
    const ttlMs = CURSOR_TTL_S * 1000;
    expect(decodeCursor(cursor, [KEY], NOW + ttlMs - 1, BINDING).k).toEqual(PAYLOAD.k);
    expect(refusal(() => decodeCursor(cursor, [KEY], NOW + ttlMs, BINDING))).toBe('expired');
  });

  it('are bound to their filters and sort (acceptance 4)', () => {
    const cursor = encodeCursor(PAYLOAD, [KEY], NOW);
    const otherFilters = { ...BINDING, filterHash: `sha256:${'b'.repeat(64)}` };
    expect(refusal(() => decodeCursor(cursor, [KEY], NOW, otherFilters))).toBe('mismatch');
    expect(refusal(() => decodeCursor(cursor, [KEY], NOW, { ...BINDING, sort: 'id' }))).toBe(
      'mismatch',
    );
  });

  it('refuse a cursor with any one character or byte changed (acceptance 4)', () => {
    const cursor = encodeCursor(PAYLOAD, [KEY], NOW);
    for (let i = 0; i < cursor.length; i++) {
      expect(refusal(() => decodeCursor(replaceAt(cursor, i), [KEY], NOW, BINDING))).toBe(
        'invalid',
      );
    }
    const [id = '', payload = '', signature = ''] = cursor.split('.');
    const bytes = Buffer.from(payload, 'base64url');
    bytes[3] = (bytes[3] ?? 0) ^ 1;
    const flipped = `${id}.${bytes.toString('base64url')}.${signature}`;
    expect(refusal(() => decodeCursor(flipped, [KEY], NOW, BINDING))).toBe('invalid');
  });

  it('cannot be forged without the key (acceptance 5)', () => {
    const impostor = { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) };
    const forged = encodeCursor({ ...PAYLOAD, k: ['9999-12-31', 'itm_9'] }, [impostor], NOW);
    expect(refusal(() => decodeCursor(forged, [KEY], NOW, BINDING))).toBe('invalid');
    const truncated = encodeCursor(PAYLOAD, [KEY], NOW).slice(0, -2);
    expect(refusal(() => decodeCursor(truncated, [KEY], NOW, BINDING))).toBe('invalid');
  });

  it('verify with every configured key and sign with the newest (acceptance 6)', () => {
    const [newer, older] = [signingKey('k2'), KEY];
    const old = encodeCursor(PAYLOAD, [older], NOW);
    expect(decodeCursor(old, [newer, older], NOW, BINDING).k).toEqual(PAYLOAD.k);
    expect(encodeCursor(PAYLOAD, [newer, older], NOW)).toMatch(/^k2\./);
    // Once the old key is dropped, its cursors stop working; unknown key ids never work.
    expect(refusal(() => decodeCursor(old, [newer], NOW, BINDING))).toBe('invalid');
    expect(
      refusal(() => decodeCursor(old.replace(/^k1/, 'k9'), [newer, older], NOW, BINDING)),
    ).toBe('invalid');
  });

  it.each([
    ['nothing', ''],
    ['two parts', 'k1.abc'],
    ['four parts', 'k1.a.b.c'],
    ['a bad key id', 'k!.abc.def'],
    ['non-base64url text', 'k1.ab+c.def'],
    ['far too long', `k1.${'a'.repeat(2000)}.b`],
  ])('refuse %s', (_name, cursor) => {
    expect(refusal(() => decodeCursor(cursor, [KEY], NOW, BINDING))).toBe('invalid');
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON string', '"hello"'],
    ['another version', JSON.stringify({ ...PAYLOAD, v: 2, exp: 9e9 })],
    ['no keyset values', JSON.stringify({ ...PAYLOAD, v: 1, k: [], exp: 9e9 })],
    ['three keyset values', JSON.stringify({ ...PAYLOAD, v: 1, k: ['a', 'b', 'c'], exp: 9e9 })],
    ['an object keyset value', JSON.stringify({ ...PAYLOAD, v: 1, k: [{}], exp: 9e9 })],
    ['a fractional expiry', JSON.stringify({ ...PAYLOAD, v: 1, exp: 9e9 + 0.5 })],
    ['no filter hash', JSON.stringify({ v: 1, k: ['a'], s: BINDING.sort, exp: 9e9 })],
  ])('refuse a correctly signed payload that is %s', (_name, payload) => {
    expect(refusal(() => decodeCursor(signRaw(KEY, payload), [KEY], NOW, BINDING))).toBe('invalid');
  });

  it('refuse to encode without a key, or keyset values a cursor cannot carry', () => {
    expect(() => encodeCursor(PAYLOAD, [], NOW)).toThrow(TypeError);
    for (const k of [[], ['a', 'b', 'c'], [Number.NaN], ['x'.repeat(201)]]) {
      expect(() => encodeCursor({ ...PAYLOAD, k }, [KEY], NOW)).toThrow(TypeError);
    }
    expect(
      decodeCursor(encodeCursor({ ...PAYLOAD, k: [42, 'itm_1'] }, [KEY], NOW), [KEY], NOW, BINDING)
        .k,
    ).toEqual([42, 'itm_1']);
  });
});

describe('paginationConfig', () => {
  const secret = (): string => randomBytes(24).toString('base64url');

  it('reads the keys newest first, as Secrets', () => {
    const [newer, older] = [secret(), secret()];
    const { signingKeys } = paginationConfig({ CURSOR_SIGNING_KEYS: `k2:${newer},k1:${older}` });
    expect(signingKeys.map((k) => k.id)).toEqual(['k2', 'k1']);
    expect(Buffer.from(signingKeys[0]?.secret.reveal() ?? []).toString('utf8')).toBe(newer);
    expect(String(signingKeys[1]?.secret)).toBe('[redacted]');
  });

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['without an id', `:${'s'.repeat(40)}`],
    ['without a colon', 's'.repeat(40)],
    ['with a short secret', 'k1:short'],
    ['with a bad id', `k 1:${'s'.repeat(40)}`],
    ['with a repeated id', `k1:${'s'.repeat(40)},k1:${'t'.repeat(40)}`],
  ])('refuses to start when CURSOR_SIGNING_KEYS is %s, without echoing it', (_name, value) => {
    let error: unknown;
    try {
      paginationConfig(value === undefined ? {} : { CURSOR_SIGNING_KEYS: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((i) => i.key)).toEqual(['CURSOR_SIGNING_KEYS']);
    if (value !== undefined && value.length > 0)
      expect((error as ConfigError).message).not.toContain(value);
  });
});
