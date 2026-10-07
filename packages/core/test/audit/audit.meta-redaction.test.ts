/**
 * Audit meta (B036, card test audit.meta-redaction.test.ts, acceptance 3): only the action's
 * allowlisted keys are kept (others are dropped unread); values are strings, finite numbers,
 * booleans or null; a string over 200 characters, or meta over 2 KiB serialised, is refused
 * before anything is written; and a value holding a secret or personal data (a CT-AUTH API key,
 * a JWT, a `sha256:` digest, an e-mail or IP address) is stored as `[redacted]`, wherever it sits
 * in the string. Property tests cover the patterns and the limits over generated input.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_META_MAX_BYTES,
  AUDIT_META_MAX_STRING,
  createAuditEmitter,
  defineAuditActions,
  InvalidAuditEventError,
  isSecretLike,
  REDACTED,
  sanitizeAuditMeta,
} from '../../src/index.js';
import { JWT, LIVE_KEY, TEST_KEY } from '../log/helpers.js';
import { fakeDb, IDS, sampleEvent } from './helpers.js';

const ROLE_CHANGE = AUDIT_ACTIONS['member.role_change'].meta;
/** Ten keys, k0…k9, for the size limit. */
const TEN_KEYS = Array.from({ length: 10 }, (_, i) => `k${i}`);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const DIGEST = `sha256:${createHash('sha256').update('a token').digest('hex')}`;

describe('meta keys', () => {
  it("keeps only the action's allowlisted keys, in the allowlist's order", () => {
    const meta = {
      to_role: 'admin',
      email: 'ada@example.com',
      user_id: IDS.member,
      display_name: 'Ada',
      from_role: 'member',
    };
    expect(Object.keys(sanitizeAuditMeta(meta, ROLE_CHANGE))).toEqual([
      'user_id',
      'from_role',
      'to_role',
    ]);
  });

  it('never reads a key outside the allowlist', () => {
    let read = false;
    const meta = Object.defineProperty({ to_role: 'admin' }, 'secret', {
      enumerable: true,
      get: () => {
        read = true;
        return 'x';
      },
    });
    const polluting = JSON.parse('{"__proto__": {"polluted": true}, "to_role": "owner"}') as object;
    expect(sanitizeAuditMeta(meta, ROLE_CHANGE)).toEqual({ to_role: 'admin' });
    expect(sanitizeAuditMeta(polluting, ROLE_CHANGE)).toEqual({ to_role: 'owner' });
    expect(read).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('is applied by the emitter: the row keeps only the allowed keys', async () => {
    const trx = fakeDb(true);
    const emitter = createAuditEmitter({ db: fakeDb() });
    await emitter.emit(
      trx,
      sampleEvent({ meta: { to_role: 'admin', note: 'promoted for the launch', token: LIVE_KEY } }),
    );
    expect(trx.rows[0]?.['meta']).toBe('{"to_role":"admin"}');
  });
});

describe('meta values', () => {
  it('keeps strings, finite numbers, booleans and null, and skips undefined', () => {
    const allowed = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(
      sanitizeAuditMeta({ a: 'owner', b: 42, c: -0.5, d: false, e: null, f: undefined }, allowed),
    ).toEqual({ a: 'owner', b: 42, c: -0.5, d: false, e: null });
    expect(sanitizeAuditMeta(undefined, allowed)).toEqual({});
    expect(sanitizeAuditMeta(null, allowed)).toEqual({});
    expect(sanitizeAuditMeta(Object.create(null) as object, allowed)).toEqual({});
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', { role: 'admin' }],
    ['an array', ['admin']],
    ['a function', () => 'admin'],
    ['a bigint', 10n],
    ['a symbol', Symbol('admin')],
    ['a date', new Date(0)],
  ])('refuses %s', (_name, value) => {
    expect(() => sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE)).toThrow(
      InvalidAuditEventError,
    );
    expect(() => sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE)).toThrow(/meta\.to_role/);
  });

  it.each([
    ['an array', ['admin']],
    ['a Map', new Map([['to_role', 'admin']])],
    ['a Date', new Date(0)],
    ['a string', 'to_role=admin'],
    ['a number', 7],
  ])('refuses meta that is %s', (_name, meta) => {
    expect(() => sanitizeAuditMeta(meta, ROLE_CHANGE)).toThrow('meta must be a plain object');
  });

  it('refuses strings over 200 characters, counted in code points', () => {
    const ok = (value: string): unknown => sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE);
    expect(AUDIT_META_MAX_STRING).toBe(200);
    expect(ok('a'.repeat(200))).toEqual({ to_role: 'a'.repeat(200) });
    expect(() => ok('a'.repeat(201))).toThrow('meta.to_role is longer than 200 characters');
    // 200 emoji are 400 UTF-16 code units but 200 characters.
    expect(ok('😀'.repeat(200))).toEqual({ to_role: '😀'.repeat(200) });
    expect(() => ok('😀'.repeat(201))).toThrow(/longer than 200/);
    // A long secret is refused too: neither way is it stored.
    expect(() => ok(`${'a'.repeat(200)}${LIVE_KEY}`)).toThrow(/longer than 200/);
  });

  it('refuses meta over 2 KiB serialised, before anything is written', async () => {
    // Ten keys: 1 + 8·10 bytes of JSON around the values, so values of 1 967 bytes make 2 048.
    const meta = (last: number): Record<string, string> =>
      Object.fromEntries(TEN_KEYS.map((k, i) => [k, 'x'.repeat(i < 9 ? 200 : last)]));
    expect(bytes(meta(167))).toBe(AUDIT_META_MAX_BYTES);
    expect(sanitizeAuditMeta(meta(167), TEN_KEYS)).toEqual(meta(167));
    expect(() => sanitizeAuditMeta(meta(168), TEN_KEYS)).toThrow(
      'meta is 2049 bytes serialised; at most 2048 are allowed',
    );
    // Bytes, not characters: four values of 200 euro signs (3 bytes each) are over 2 KiB.
    const euros = Object.fromEntries(TEN_KEYS.slice(0, 4).map((k) => [k, '€'.repeat(200)]));
    expect(() => sanitizeAuditMeta(euros, TEN_KEYS)).toThrow('meta is 2433 bytes serialised');
    const actions = defineAuditActions({ 'test.size': { meta: TEN_KEYS } });
    const trx = fakeDb(true);
    const emitter = createAuditEmitter({ db: fakeDb(), actions });
    await expect(
      emitter.emit(trx, { ...sampleEvent(), action: 'test.size', meta: meta(168) }),
    ).rejects.toThrow(InvalidAuditEventError);
    expect(trx.queries).toEqual([]);
  });
});

describe('redaction', () => {
  it.each([
    ['a live API key', LIVE_KEY],
    ['a test API key, in upper case', TEST_KEY.toUpperCase()],
    ['an API key inside text', `key=${LIVE_KEY};`],
    ['a JWT', JWT],
    ['a bearer JWT', `Bearer ${JWT}`],
    ['a sha256 digest', DIGEST],
    ['an e-mail address', 'ada@example.com'],
    ['an e-mail address inside text', 'invited (ada.lovelace+centcom@mail.example.org)'],
    ['an IPv4 address', '203.0.113.7'],
    ['an IPv4 address and port', '203.0.113.7:443'],
    ['a full IPv6 address', '2001:0db8:0000:0000:0000:ff00:0042:8329'],
    ['an abbreviated IPv6 address', '2001:db8::1'],
    ['the IPv6 loopback', '::1'],
    ['an IPv4-mapped IPv6 address', '::ffff:192.0.2.1'],
  ])('replaces %s with [redacted]', (_name, value) => {
    expect(isSecretLike(value)).toBe(true);
    expect(sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE)).toEqual({ to_role: REDACTED });
  });

  it.each([
    ['an id', IDS.member],
    ['an enum', 'owner'],
    ['an action name', 'member.role_change'],
    ['a timestamp', '2026-10-07T12:00:00.000Z'],
    ['a scope list', 'workspaces:read sessions:write'],
    ['a field list', 'name,settings.default_mode'],
    ['a version', '1.2.3'],
    ['a count', '1500'],
  ])('keeps %s as it is', (_name, value) => {
    expect(isSecretLike(value)).toBe(false);
    expect(sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE)).toEqual({ to_role: value });
  });
});

describe('properties', () => {
  const base64url = (value: string | Uint8Array): string =>
    Buffer.from(value).toString('base64url');
  // A JOSE header or claims set: names start with a letter (`{"alg"…`), so the base64url of a
  // header starts with `eyJ`, as every real one does.
  const json = fc.dictionary(
    fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
    fc.string({ maxLength: 6 }),
    {
      minKeys: 1,
      maxKeys: 2,
    },
  );
  const secret = fc.oneof(
    fc
      .tuple(fc.constantFrom('live', 'test'), fc.stringMatching(/^[0-9A-Za-z]{1,40}$/))
      .map(([mode, rest]) => ['cen', mode, rest].join('_')),
    fc
      .tuple(json, json, fc.uint8Array({ minLength: 1, maxLength: 24 }))
      .map(([header, claims, sig]) =>
        [base64url(JSON.stringify(header)), base64url(JSON.stringify(claims)), base64url(sig)].join(
          '.',
        ),
      ),
    fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((d) => `sha256:${Buffer.from(d).toString('hex')}`),
    fc.emailAddress({ size: 'small' }),
    fc.ipV4(),
    fc.ipV6(),
  );
  const text = fc.string({ maxLength: 40, unit: 'grapheme-ascii' });
  const gap = fc.constantFrom(' ', ', ', '; ', '=', ' (', '\t');

  it('redacts a secret or address wherever it sits in a value', () => {
    fc.assert(
      fc.property(text, gap, secret, gap, text, (before, g1, value, g2, after) => {
        const meta = { to_role: `${before}${g1}${value}${g2}${after}` };
        fc.pre(Array.from(meta.to_role).length <= AUDIT_META_MAX_STRING);
        expect(sanitizeAuditMeta(meta, ROLE_CHANGE)).toEqual({ to_role: REDACTED });
      }),
      { numRuns: 500 },
    );
  });

  it('keeps ids, enums and lists as they are', () => {
    const plain = fc
      .stringMatching(/^[a-z0-9_,-]{0,200}$/)
      .filter((s) => !/cen_(?:live|test)_/.test(s));
    fc.assert(
      fc.property(plain, (value) => {
        expect(sanitizeAuditMeta({ to_role: value }, ROLE_CHANGE)).toEqual({ to_role: value });
      }),
      { numRuns: 300 },
    );
  });

  it('either refuses meta or stores allowlisted, bounded, secret-free values', () => {
    const value = fc.oneof(
      fc.string({ maxLength: 260 }),
      secret,
      fc.double(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.object({ maxDepth: 1 }),
    );
    const key = fc.oneof(fc.constantFrom(...TEN_KEYS), fc.string({ maxLength: 8 }));
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 14 }), (meta) => {
        let out: Record<string, unknown>;
        try {
          out = sanitizeAuditMeta(meta, TEN_KEYS);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidAuditEventError);
          return;
        }
        expect(Object.keys(out).every((k) => TEN_KEYS.includes(k))).toBe(true);
        expect(bytes(out)).toBeLessThanOrEqual(AUDIT_META_MAX_BYTES);
        for (const v of Object.values(out)) {
          expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
          if (typeof v === 'string') {
            expect(Array.from(v).length).toBeLessThanOrEqual(AUDIT_META_MAX_STRING);
            expect(v === REDACTED || !isSecretLike(v)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
