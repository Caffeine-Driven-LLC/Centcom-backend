/** CT-IDS time, money and text rules. */
import { describe, expect, it } from 'vitest';
import {
  assertNoControlChars,
  checkName,
  checkSlug,
  formatTimestamp,
  hasControlChars,
  isMoney,
  isTimestamp,
  money,
  normaliseEmail,
  normaliseText,
  parseMoney,
  parseTimestamp,
  TextError,
} from '../src/index.js';

describe('timestamps', () => {
  it('formats with millisecond precision and Z', () => {
    expect(formatTimestamp(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(formatTimestamp(new Date(Date.UTC(2026, 9, 5, 18, 7, 41, 123)))).toBe('2026-10-05T18:07:41.123Z');
  });

  it('refuses an invalid Date or a year outside 0000-9999', () => {
    expect(() => formatTimestamp(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => formatTimestamp(new Date(Date.UTC(10_000, 0, 1)))).toThrow(RangeError);
  });

  it('parses exactly the wire format', () => {
    expect(parseTimestamp('2026-10-05T18:07:41.123Z')?.getTime()).toBe(Date.UTC(2026, 9, 5, 18, 7, 41, 123));
    expect(isTimestamp('2026-10-05T18:07:41.123Z')).toBe(true);
  });

  it.each([
    ['no Z', '2026-10-05T18:07:41.123'],
    ['an offset', '2026-10-05T18:07:41.123+00:00'],
    ['no milliseconds', '2026-10-05T18:07:41Z'],
    ['microseconds', '2026-10-05T18:07:41.123456Z'],
    ['lower-case z', '2026-10-05T18:07:41.123z'],
    ['a space for T', '2026-10-05 18:07:41.123Z'],
    ['an impossible date', '2026-02-30T00:00:00.000Z'],
    ['hour 24', '2026-10-05T24:00:00.000Z'],
    ['a leap second', '2016-12-31T23:59:60.000Z'],
    ['trailing text', '2026-10-05T18:07:41.123Zx'],
  ])('rejects %s', (_, value) => {
    expect(parseTimestamp(value)).toBeNull();
    expect(isTimestamp(value)).toBe(false);
  });

  it.each([undefined, null, 0, {}, new Date(0)])('returns null for non-string %j', (v) => {
    expect(parseTimestamp(v)).toBeNull();
  });
});

describe('money', () => {
  it('builds and checks integer minor units in USD or EUR', () => {
    expect(money(1900, 'USD')).toEqual({ amount: 1900, currency: 'USD' });
    expect(isMoney({ amount: 0, currency: 'EUR' })).toBe(true);
    expect(parseMoney({ amount: -500, currency: 'USD' }).ok).toBe(true);
  });

  it.each([
    ['a float', { amount: 19.99, currency: 'USD' }, '/amount'],
    ['an unsafe integer', { amount: 1e21, currency: 'USD' }, '/amount'],
    ['a string amount', { amount: '1900', currency: 'USD' }, '/amount'],
    ['another currency', { amount: 1900, currency: 'GBP' }, '/currency'],
    ['no currency', { amount: 1900 }, '/currency'],
  ])('rejects %s', (_, value, pointer) => {
    const r = parseMoney(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.pointer)).toContain(pointer);
    expect(isMoney(value)).toBe(false);
  });

  it('money() throws for programming errors', () => {
    expect(() => money(1.5, 'USD')).toThrow(RangeError);
    expect(() => money(100, 'GBP' as 'USD')).toThrow(RangeError);
  });
});

describe('text', () => {
  it('NFC-normalises (NFD e + U+0301 becomes U+00E9)', () => {
    expect(normaliseText('é')).toBe('é');
    expect(normaliseText('café')).toBe('café');
  });

  it('rejects U+0000-U+001F except \\n and \\t', () => {
    expect(() => assertNoControlChars('bell\u0007')).toThrow(TextError);
    expect(() => assertNoControlChars('line\nnext\tcol')).not.toThrow();
    for (let c = 0; c <= 0x1f; c++) {
      const allowed = c === 0x09 || c === 0x0a;
      expect(hasControlChars(`a${String.fromCharCode(c)}b`), `U+${c.toString(16)}`).toBe(!allowed);
    }
    expect(hasControlChars('\u007f\u0080')).toBe(false); // outside the CT-IDS range
  });

  it('TextError carries a CT-ERR code and an issue', () => {
    try {
      assertNoControlChars('\u0000');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TextError);
      expect((e as TextError).code).toBe('validation_failed');
      expect((e as TextError).issue).toEqual({ pointer: '', code: 'invalid_format', detail: 'control character U+0000 is not allowed' });
    }
  });

  it.each([
    ['displayName', 40],
    ['workspaceName', 60],
    ['sessionName', 80],
  ] as const)('%s: 1-%i code points after NFC', (kind, max) => {
    expect(checkName(kind, 'x'.repeat(max))).toEqual({ ok: true, value: 'x'.repeat(max) });
    expect(checkName(kind, 'x'.repeat(max + 1)).ok).toBe(false);
    expect(checkName(kind, '').ok).toBe(false);
    // max emoji (2 UTF-16 units each) still fit: lengths count code points
    expect(checkName(kind, '\u{1F419}'.repeat(max)).ok).toBe(true);
    // NFD input that is max long only after NFC normalisation
    expect(checkName(kind, 'é'.repeat(max))).toEqual({ ok: true, value: 'é'.repeat(max) });
  });

  it('names reject control characters and non-strings', () => {
    expect(checkName('displayName', 'a\u0000b')).toMatchObject({ ok: false, errors: [{ code: 'invalid_format' }] });
    expect(checkName('displayName', 42)).toMatchObject({ ok: false, errors: [{ code: 'invalid_type' }] });
  });

  it.each(['abc', 'my-team-01', 'a'.repeat(40)])('slug %s is valid', (s) => {
    expect(checkSlug(s)).toEqual({ ok: true, value: s });
  });

  it.each(['ab', 'a'.repeat(41), 'My-Team', 'my_team', 'my team', 'café', 7])('slug %j is invalid', (s) => {
    expect(checkSlug(s).ok).toBe(false);
  });

  it('e-mail addresses are lower-cased, NFC and at most 254 characters', () => {
    expect(normaliseEmail('Ada@Example.COM')).toEqual({ ok: true, value: 'ada@example.com' });
    expect(normaliseEmail(`${'a'.repeat(242)}@example.com`).ok).toBe(true); // 254
    expect(normaliseEmail(`${'a'.repeat(243)}@example.com`).ok).toBe(false); // 255
    expect(normaliseEmail('').ok).toBe(false);
    expect(normaliseEmail('a\u0007@b.c').ok).toBe(false);
    expect(normaliseEmail(null).ok).toBe(false);
  });
});
