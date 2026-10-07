/**
 * Profile field rules (B013 acceptance 4 and 5, table-driven): display names, locales, e-mail
 * addresses and avatar slots, the patch as a whole, the default display name, and the error shape
 * (a 422 validation AppError pointing at the field, never echoing the value).
 */
import { AppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  checkAvatarSlot,
  checkDisplayName,
  checkEmail,
  checkLocale,
  defaultDisplayName,
  validateDisplayName,
  validateEmail,
  validateLocale,
  validateProfilePatch,
} from '../../../src/modules/users/index.js';

const NFD = 'Zoé'; // "Zoé" with a combining accent
const NFC = 'Zoé';

/** The AppError `fn` throws. */
function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

describe('display name', () => {
  it.each([
    ['', 'too_short'],
    ['x'.repeat(41), 'too_long'],
    ['nul\u0000name', 'invalid_format'],
    ['bell\u0007', 'invalid_format'],
    [42, 'invalid_type'],
  ])('rejects %j (%s) at /display_name (acceptance 4)', (value, code) => {
    expect(checkDisplayName(value).issues).toEqual([
      { pointer: '/display_name', code, detail: expect.any(String) as string },
    ]);
  });

  it.each([
    ['G', 'G'],
    ['x'.repeat(40), 'x'.repeat(40)],
    [NFD, NFC],
    ['😀'.repeat(40), '😀'.repeat(40)],
  ])('accepts %j as %j (NFD is stored NFC; lengths count code points)', (value, stored) => {
    expect(checkDisplayName(value)).toEqual({ value: stored, issues: [] });
  });

  it('throws one 422 validation AppError that points at the field and does not echo the value', () => {
    const err = thrown(() => validateDisplayName('x'.repeat(41)));
    expect(err).toMatchObject({ code: 'validation_failed', status: 422 });
    expect(err.errors).toEqual([
      { pointer: '/display_name', code: 'too_long', detail: 'must be at most 40 characters' },
    ]);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('x'.repeat(41));
    expect(validateDisplayName(NFD)).toBe(NFC);
  });
});

describe('locale', () => {
  it.each([
    ['en-GB', 'en-GB'],
    ['en-gb', 'en-GB'],
    ['EN', 'en'],
    ['eng', 'en'],
    ['fil', 'fil'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
    ['de-DE-1996', 'de-DE-1996'],
  ])('accepts %j as %j (acceptance 5)', (value, stored) => {
    expect(checkLocale(value)).toEqual({ value: stored, issues: [] });
  });

  it.each([
    ['english'],
    ['en_GB'],
    ['e'],
    [''],
    ['x-private'],
    ['i-klingon'],
    ['abcd'],
    [`en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}`],
  ])('rejects %j (acceptance 5)', (value) => {
    expect(checkLocale(value).issues).toEqual([
      { pointer: '/locale', code: 'invalid_format', detail: expect.any(String) as string },
    ]);
  });

  it('rejects what is not a string, and throws for validateLocale', () => {
    expect(checkLocale(7).issues[0]).toMatchObject({ pointer: '/locale', code: 'invalid_type' });
    expect(thrown(() => validateLocale('english')).errors?.[0]).toMatchObject({
      pointer: '/locale',
    });
    expect(validateLocale('en-gb')).toBe('en-GB');
  });
});

describe('e-mail', () => {
  it.each([
    ['A@Example.COM', 'a@example.com'],
    [`${NFD}@example.test`, `${NFC.toLowerCase()}@example.test`],
    ['first.last+tag@sub.example.test', 'first.last+tag@sub.example.test'],
  ])('normalises %j to %j', (value, stored) => {
    expect(checkEmail(value)).toEqual({ value: stored, issues: [] });
  });

  it.each([
    ['no-at-sign', 'invalid_format'],
    ['a@b@c', 'invalid_format'],
    ['a b@c.test', 'invalid_format'],
    ['@example.test', 'invalid_format'],
    ['me@', 'invalid_format'],
    ['', 'too_short'],
    [`${'a'.repeat(250)}@b.cd`, 'too_long'],
    ['a\u0000@b.test', 'invalid_format'],
    [null, 'invalid_type'],
  ])('rejects %j (%s) at /email', (value, code) => {
    expect(checkEmail(value).issues).toEqual([
      { pointer: '/email', code, detail: expect.any(String) as string },
    ]);
  });

  it('throws a validation AppError for an invalid address', () => {
    expect(thrown(() => validateEmail('nope')).errors).toEqual([
      { pointer: '/email', code: 'invalid_format', detail: 'must be an e-mail address' },
    ]);
    expect(validateEmail('A@B.TEST')).toBe('a@b.test');
  });
});

describe('avatar slot', () => {
  it.each([
    [null, null],
    ['slot-3', 'slot-3'],
    ['a'.repeat(64), 'a'.repeat(64)],
  ])('accepts %j', (value, stored) => {
    expect(checkAvatarSlot(value)).toEqual({ value: stored, issues: [] });
  });

  it.each([
    ['', 'too_short'],
    ['a'.repeat(65), 'too_long'],
    ['a\u0001', 'invalid_format'],
    [3, 'invalid_type'],
  ])('rejects %j (%s)', (value, code) => {
    expect(checkAvatarSlot(value).issues).toEqual([
      { pointer: '/avatar_slot', code, detail: expect.any(String) as string },
    ]);
  });
});

describe('validateProfilePatch', () => {
  it('returns the checked, normalised fields', () => {
    expect(
      validateProfilePatch({
        display_name: NFD,
        locale: 'en-gb',
        avatar_slot: null,
        telemetry_opt_in: true,
      }),
    ).toEqual({ display_name: NFC, locale: 'en-GB', avatar_slot: null, telemetry_opt_in: true });
    expect(validateProfilePatch({ locale: 'fr', display_name: undefined })).toEqual({
      locale: 'fr',
    });
  });

  it('reports every bad field in one error: unknown fields, wrong types, bad values', () => {
    const err = thrown(() =>
      validateProfilePatch({
        display_name: '',
        locale: 'english',
        telemetry_opt_in: 'yes',
        email: 'a@b.c',
      }),
    );
    expect(err.code).toBe('validation_failed');
    expect(err.errors?.map((e) => [e.pointer, e.code])).toEqual([
      ['/email', 'not_allowed'],
      ['/display_name', 'too_short'],
      ['/locale', 'invalid_format'],
      ['/telemetry_opt_in', 'invalid_type'],
    ]);
  });

  it('refuses an empty patch and anything that is not an object', () => {
    expect(thrown(() => validateProfilePatch({})).errors).toEqual([
      { pointer: '', code: 'too_few', detail: 'must change at least one field' },
    ]);
    for (const value of [null, [], 'name', 3]) {
      expect(thrown(() => validateProfilePatch(value)).errors?.[0]).toMatchObject({
        pointer: '',
        code: 'invalid_type',
      });
    }
  });
});

describe('defaultDisplayName', () => {
  it.each([
    ['grace@example.test', undefined, 'grace'],
    ['grace@example.test', 'Grace Hopper', 'Grace Hopper'],
    ['grace@example.test', '  Grace\u0000 Hopper ', 'Grace Hopper'],
    ['grace@example.test', '', 'grace'],
    ['grace@example.test', '\u0000\u0001', 'grace'],
    ['grace@example.test', 'n'.repeat(60), 'n'.repeat(40)],
    [`${'l'.repeat(60)}@example.test`, undefined, 'l'.repeat(40)],
    [`${NFD}@example.test`, undefined, NFC],
    ['@example.test', undefined, 'User'],
  ])('for %j with hint %j is %j', (email, hint, name) => {
    expect(defaultDisplayName(email, hint)).toBe(name);
  });
});
