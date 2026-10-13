/**
 * The contract patterns (B101): the generated module equals the contract file, every pattern has
 * trigger text that its examples contain, and the contract's `must_match` / `must_not_match`
 * strings behave in `scanText`, in JSON at depth 5 (key and value positions) and across the
 * boundary of a 64 KiB window in a 300 KiB text.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadPatterns, mayMatch } from '../patterns.js';
import { scanJson, scanText } from '../scan.js';
import { EXPECTED, FIXTURE, GENERATED } from '../../../test/secret-guard/helpers.js';

describe('patterns', () => {
  it('the generated module equals the contract file, pattern for pattern', () => {
    expect(GENERATED.map((p) => ({ id: p.id, regex: p.regex }))).toEqual(FIXTURE.patterns);
  });

  it('compiles all 7 patterns once and shares them', () => {
    const patterns = loadPatterns();
    expect(patterns).toHaveLength(7);
    expect(loadPatterns()).toBe(patterns);
    for (const p of patterns) expect(p.triggers.length).toBeGreaterThan(0);
  });

  it('every must_match string holds a trigger of the pattern that matches it (the prefilter is sound)', () => {
    for (const text of FIXTURE.must_match) {
      const matching = loadPatterns().filter((p) => new RegExp(p.regex.source).test(text));
      expect(matching.length).toBeGreaterThan(0);
      for (const p of matching) expect(mayMatch(p, text), `${p.id}`).toBe(true);
    }
  });
});

describe('the contract examples', () => {
  it.each(EXPECTED)('%s produces exactly one hit, pattern %s', (text, id) => {
    const hits = scanText(text);
    expect(hits).toEqual([{ pattern: id, offset: 0, length: text.length }]);
  });

  it('the must_not_match strings produce no hit', () => {
    for (const text of FIXTURE.must_not_match) expect(scanText(text), text).toEqual([]);
  });

  it('one hit per example inside JSON at depth 5, as a value and as a key', () => {
    for (const [text, id] of EXPECTED) {
      const asValue = { a: { b: { c: { d: [{ e: text }] } } } };
      expect(scanJson(asValue).map((h) => h.pattern)).toEqual([id]);
      const asKey = { a: { b: { c: { d: { [text]: 1 } } } } };
      expect(scanJson(asKey).map((h) => h.pattern)).toEqual([id]);
    }
    for (const text of FIXTURE.must_not_match) {
      expect(scanJson({ a: { b: { c: { d: [{ e: text }] } } } })).toEqual([]);
    }
  });

  it.each([65_535, 65_536, 65_537, 0])(
    'finds an example once at offset %i of a 300 KiB text',
    (offset) => {
      for (const [text, id] of EXPECTED) {
        const filler = ' '.repeat(300 * 1024);
        const body = filler.slice(0, offset) + text + filler.slice(offset + text.length);
        expect(scanText(body)).toEqual([{ pattern: id, offset, length: text.length }]);
      }
    },
  );
});

describe('the JWT walk equals the contract regex', () => {
  const regex = new RegExp(
    loadPatterns().find((p) => p.id === 'openai_oauth_access')?.regex.source ?? '',
    'g',
  );
  const alphabet = fc.constantFrom('eyJ', 'a', 'B', '1', '_', '-', '.', '.', ' ', 'x'.repeat(10));
  it('finds the same non-overlapping matches on random dotted text', () => {
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 60 }), (parts) => {
        const text = parts.join('');
        const expected = [...text.matchAll(regex)].map((m) => [m.index, m[0].length]);
        const got = scanText(text.padEnd(20, ' '))
          .filter((h) => h.pattern === 'openai_oauth_access')
          .map((h) => [h.offset, h.length]);
        // the regex can match inside another pattern's range; compare only when no other pattern hits
        const others = scanText(text.padEnd(20, ' ')).filter(
          (h) => h.pattern !== 'openai_oauth_access',
        );
        if (others.length === 0) expect(got).toEqual(expected);
      }),
      { numRuns: 1500 },
    );
  });
});
