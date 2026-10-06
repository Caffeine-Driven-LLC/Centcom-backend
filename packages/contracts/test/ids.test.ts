/** CT-IDS identifiers: format, monotonicity, prefix table, length limit. */
import { describe, expect, it } from 'vitest';
import { createIdGenerator, ID_PREFIXES, isId, MAX_ID_BYTES, newId, parseId, type IdPrefix } from '../src/index.js';
import { readContractText } from './contracts.js';

const ULID_ID = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const fixedRandom = (byte: number) => () => new Uint8Array(10).fill(byte);

describe('prefix table', () => {
  it('matches the CT-IDS table in contracts/00-foundations.md exactly', () => {
    const doc = readContractText('00-foundations.md');
    const table = doc.slice(doc.indexOf('| Entity | Prefix |'), doc.indexOf('- IDs are opaque'));
    const prefixes = [...table.matchAll(/`([a-z]{3})`/g)].map((m) => m[1]);
    expect(prefixes).toHaveLength(24);
    expect([...ID_PREFIXES].sort()).toEqual([...prefixes].sort());
  });
});

describe('newId', () => {
  it('returns <prefix>_<26 Crockford base32 chars>', () => {
    expect(newId('ses')).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    for (const prefix of ID_PREFIXES) expect(newId(prefix)).toMatch(ULID_ID(prefix));
  });

  it('encodes the timestamp in the first 10 ULID characters', () => {
    const gen = createIdGenerator({ now: () => 0, random: fixedRandom(0) });
    expect(gen('usr')).toBe('usr_00000000000000000000000000');
    const max = createIdGenerator({ now: () => 2 ** 48 - 1, random: fixedRandom(0xff) });
    expect(max('usr')).toBe('usr_7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
    // Expected value computed independently (Python, Crockford base32 of 1_727_000_000_000).
    expect(createIdGenerator({ now: () => 1_727_000_000_000, random: fixedRandom(0) })('msg').slice(4, 14)).toBe('01J8CKHDG0');
  });

  it('is strictly increasing for 1 000 000 ids within the same millisecond', () => {
    let calls = 0;
    const gen = createIdGenerator({
      now: () => 1_759_687_661_123,
      random: () => {
        calls++;
        return new Uint8Array(10).fill(0x7f);
      },
    });
    let previous = gen('ses');
    for (let i = 1; i < 1_000_000; i++) {
      const id = gen('ses');
      if (!(id > previous)) throw new Error(`not increasing at ${i}: ${previous} >= ${id}`);
      previous = id;
    }
    expect(calls).toBe(1); // one random draw, then increments
  });

  it('stays monotonic when the clock moves backwards', () => {
    let t = 10_000;
    const gen = createIdGenerator({ now: () => t, random: fixedRandom(0x10) });
    const a = gen('que');
    t = 5_000;
    const b = gen('que');
    t = 10_000;
    const c = gen('que');
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    expect(b.slice(4, 14)).toBe(a.slice(4, 14)); // kept the later time, bumped the random part
  });

  it('moves to the next millisecond when the random part overflows', () => {
    const gen = createIdGenerator({ now: () => 1_000, random: fixedRandom(0xff) });
    const a = gen('apr');
    const b = gen('apr');
    expect(a.slice(14)).toBe('ZZZZZZZZZZZZZZZZ');
    expect(b > a).toBe(true);
    expect(b.slice(4, 14)).toBe(createIdGenerator({ now: () => 1_001 })('apr').slice(4, 14));
  });

  it('uses the CSPRNG by default (two generators at the same instant differ)', () => {
    const a = createIdGenerator({ now: () => 42 })('dev');
    const b = createIdGenerator({ now: () => 42 })('dev');
    expect(a).not.toBe(b);
  });

  it('newId shares one process-wide monotonic state, with per-call deps', () => {
    const a = newId('msg', { now: () => 1_759_000_000_000, random: fixedRandom(1) });
    const b = newId('msg', { now: () => 1_759_000_000_000, random: fixedRandom(1) });
    expect(b > a).toBe(true);
  });

  it('rejects an unknown prefix, a bad clock and bad randomness', () => {
    expect(() => newId('xyz' as IdPrefix)).toThrow(TypeError);
    expect(() => createIdGenerator({ now: () => -1 })('usr')).toThrow(RangeError);
    expect(() => createIdGenerator({ now: () => 2 ** 48 })('usr')).toThrow(RangeError);
    expect(() => createIdGenerator({ now: () => Number.NaN })('usr')).toThrow(RangeError);
    expect(() => createIdGenerator({ now: () => 1, random: () => new Uint8Array(3) })('usr')).toThrow(RangeError);
  });
});

describe('isId and parseId', () => {
  const ses = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

  it('accepts a well-formed id of the right prefix only', () => {
    expect(isId('ses', ses)).toBe(true);
    expect(isId('usr', ses)).toBe(false);
    expect(parseId(ses)).toEqual({ prefix: 'ses', ulid: '01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
  });

  it.each([
    ['lower-case ULID', 'ses_01ja3z8k2m5n7p9q0r1s2t3v4w'],
    ['excluded letter I', 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4I'],
    ['excluded letter U', 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4U'],
    ['25 characters', 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4'],
    ['27 characters', 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4WX'],
    ['unknown prefix', 'xyz_01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    ['upper-case prefix', 'SES_01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    ['no separator', 'ses01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    ['leading space', ' ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W'],
    ['empty', ''],
  ])('rejects %s', (_, value) => {
    expect(parseId(value)).toBeNull();
    expect(isId('ses', value)).toBe(false);
  });

  it(`rejects anything longer than ${MAX_ID_BYTES} bytes before matching`, () => {
    expect(parseId(`${ses}${'0'.repeat(11)}`)).toBeNull();
    expect(parseId('a'.repeat(10_000_000))).toBeNull();
  });

  it.each([undefined, null, 42, {}, ['ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W']])('returns null for non-string %j', (v) => {
    expect(parseId(v)).toBeNull();
    expect(isId('ses', v)).toBe(false);
  });
});
