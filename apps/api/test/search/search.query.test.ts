/**
 * B089 query handling (unit): NFC normalisation and lower-casing; at least 2 characters (422,
 * pointer `/q`) and at most 254 (an email's bound), no control characters; full-id detection for `ses_`, `wsp_`, `usr_` and `mem_` (stored
 * case); LIKE's `%`, `_` and `\` escaped; `type` and `limit` parsing (1..50, default 20); the
 * allow-list of searchable columns holds no content-bearing column.
 */
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  escapeLike,
  normaliseQuery,
  parseLimit,
  parseTypes,
  SEARCHABLE_COLUMNS,
} from '../../src/modules/search/query.js';

const pointerOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return (err as { errors?: { pointer: string }[] }).errors?.[0]?.pointer;
  }
  return undefined;
};

describe('normaliseQuery', () => {
  it('normalises to NFC, trims and lower-cases', () => {
    expect(normaliseQuery('  Café PLAN ').text).toBe('café plan');
  });

  it('refuses fewer than 2 characters and more than 254, with pointer /q', () => {
    for (const q of ['', ' ', 'a', ' é ']) expect(pointerOf(() => normaliseQuery(q))).toBe('/q');
    expect(pointerOf(() => normaliseQuery('x'.repeat(255)))).toBe('/q');
    expect(normaliseQuery('x'.repeat(254)).text).toHaveLength(254);
    for (const q of ['ab\u0000c', 'ab\nc', 'ab\u007fc'])
      expect(pointerOf(() => normaliseQuery(q))).toBe('/q');
    expect(pointerOf(() => normaliseQuery(undefined))).toBe('/q');
    expect(normaliseQuery('ab').text).toBe('ab');
  });

  it('detects full ids, keeping the stored case', () => {
    expect(normaliseQuery('ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W').id).toEqual({
      type: 'ses',
      value: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    });
    expect(normaliseQuery('WSP_01ja3z8k2m5n7p9q0r1s2t3v4w').id?.value).toBe(
      'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    );
    expect(normaliseQuery('ses_01JA3Z').id).toBeNull();
    expect(normaliseQuery('dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W').id).toBeNull();
  });

  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    expect(normaliseQuery('a%b').contains).toBe('%a\\%b%');
    expect(normaliseQuery("'; drop table users; --").contains).toBe("%'; drop table users; --%");
  });
});

describe('type and limit', () => {
  it('parses types, refusing unknown ones', () => {
    expect(parseTypes(undefined)).toEqual(['session', 'workspace', 'user', 'member']);
    expect(parseTypes('session,user')).toEqual(['session', 'user']);
    expect(parseTypes(['user', 'user'])).toEqual(['user']);
    expect(pointerOf(() => parseTypes('history'))).toBe('/type');
  });

  it('limit is 1..50, default 20', () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit('50')).toBe(50);
    for (const bad of ['0', '51', 'x', '-1'])
      expect(pointerOf(() => parseLimit(bad))).toBe('/limit');
  });
});

describe('the allow-list', () => {
  it('names only cleartext metadata columns', () => {
    const all = Object.values(SEARCHABLE_COLUMNS).flat();
    expect(all.every((c) => /^(sessions|workspaces|users|memberships)\./.test(c))).toBe(true);
    for (const c of all) expect(c).not.toMatch(/history|frame|blob|ct|branch|path|comment|queue/);
  });
});
