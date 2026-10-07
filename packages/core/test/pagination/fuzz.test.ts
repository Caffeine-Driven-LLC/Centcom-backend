/**
 * Cursor fuzzing (B025, card test fuzz.test.ts): whatever a client sends as a cursor, decoding
 * either succeeds (only for an untouched cursor) or throws a 400 `cursor_invalid`, never anything
 * else (so never a 500).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError, decodeCursor, encodeCursor } from '../../src/index.js';
import { BINDING, NOW, signingKey } from './helpers.js';

const KEY = signingKey('k1');
const VALID = encodeCursor(
  { k: ['2026-10-07 12:00:00+00', 'itm_1'], f: BINDING.filterHash, s: BINDING.sort },
  [KEY],
  NOW,
);

/** True if decoding `cursor` returns, or throws the one error it may throw. */
function decodesSafely(cursor: string): boolean {
  try {
    decodeCursor(cursor, [KEY], NOW, BINDING);
    return cursor === VALID;
  } catch (e) {
    return e instanceof AppError && e.code === 'cursor_invalid' && e.status === 400;
  }
}

describe('decodeCursor under fuzzing', () => {
  it('throws only cursor_invalid for arbitrary text', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.base64String()),
        (text) => {
          expect(decodesSafely(text)).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('throws only cursor_invalid for cursors with random edits', () => {
    const alphabet = fc.constantFrom(...'ABCabc019_-.'.split(''));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: VALID.length - 1 }), alphabet), {
          minLength: 1,
          maxLength: 4,
        }),
        (edits) => {
          let cursor = VALID;
          for (const [at, c] of edits) cursor = cursor.slice(0, at) + c + cursor.slice(at + 1);
          expect(decodesSafely(cursor)).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('throws only cursor_invalid for well-formed cursors with random parts', () => {
    const part = fc.string({
      unit: fc.constantFrom(...'ABCxyz0189_-'.split('')),
      minLength: 1,
      maxLength: 60,
    });
    fc.assert(
      fc.property(part, part, part, (a, b, c) => {
        expect(decodesSafely(`${a}.${b}.${c}`)).toBe(true);
      }),
      { numRuns: 1_000 },
    );
  });
});
