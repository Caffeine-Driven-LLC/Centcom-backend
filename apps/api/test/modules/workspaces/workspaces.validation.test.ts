/**
 * Workspace input rules (B027, card test workspaces.validation.test.ts, acceptance 1-2): name
 * length in code points after NFC (1-60), control characters, NFC storage, the caller's slug, and
 * slugs made from names: every generated slug fits CT-IDS `[a-z0-9-]{3,40}` and a taken one gets
 * the next free numeric suffix (property tests over random names and taken sets).
 */
import { SLUG_PATTERN } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createPatchExtensionRegistry,
  FALLBACK_SLUG,
  nextSlug,
  parseCreate,
  parseUpdate,
  SLUG_BASE_MAX,
  slugFromName,
} from '../../../src/modules/workspaces/index.js';

const issuesOf = (fn: () => unknown): { pointer: string; code: string }[] => {
  try {
    fn();
  } catch (err) {
    return (err as { errors?: { pointer: string; code: string }[] }).errors ?? [];
  }
  return [];
};

describe('parseCreate', () => {
  it('takes 1 to 60 code points after NFC, without control characters', () => {
    expect(parseCreate({ name: 'A' })).toEqual({ name: 'A' });
    expect(parseCreate({ name: '😀'.repeat(60) }).name).toHaveLength(120);
    expect(parseCreate({ name: 'é'.repeat(60) }).name).toBe('é'.repeat(60));
    expect(parseCreate({ name: 'tab\tand\nnewline' }).name).toBe('tab\tand\nnewline');
    expect(issuesOf(() => parseCreate({ name: '' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'too_short' }),
    ]);
    expect(issuesOf(() => parseCreate({ name: 'x'.repeat(61) }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'too_long' }),
    ]);
    expect(issuesOf(() => parseCreate({ name: 'a\u0007b' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'invalid_format' }),
    ]);
  });

  it('checks a slug the caller gives, reports every bad field, and ignores the rest', () => {
    expect(parseCreate({ name: 'A', slug: 'my-team', plan: 'team' })).toEqual({
      name: 'A',
      slug: 'my-team',
    });
    expect(issuesOf(() => parseCreate({ name: 7, slug: 'Bad Slug' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'invalid_type' }),
      expect.objectContaining({ pointer: '/slug', code: 'invalid_format' }),
    ]);
    expect(issuesOf(() => parseCreate(null))).toEqual([
      expect.objectContaining({ pointer: '', code: 'invalid_type' }),
    ]);
  });
});

describe('parseUpdate', () => {
  it('needs a field it can change, and names the fields that change', () => {
    const registry = createPatchExtensionRegistry();
    expect(parseUpdate({ name: 'B', color: 'red' }, registry)).toEqual({
      name: 'B',
      extensions: [],
      fields: ['name'],
    });
    expect(issuesOf(() => parseUpdate({ color: 'red' }, registry))).toEqual([
      expect.objectContaining({ pointer: '', code: 'too_few' }),
    ]);
    expect(issuesOf(() => parseUpdate([], registry))).toEqual([
      expect.objectContaining({ code: 'invalid_type' }),
    ]);
  });
});

describe('slugs', () => {
  it('come from the name: lower case, accents dropped, words joined by single dashes', () => {
    expect(slugFromName('Acme Robotics')).toBe('acme-robotics');
    expect(slugFromName('  Café — Crème brûlée!  ')).toBe('cafe-creme-brulee');
    expect(slugFromName('AI')).toBe('ai-ws');
    expect(slugFromName('漢字のみ')).toBe(FALLBACK_SLUG);
    expect(slugFromName('x'.repeat(100))).toBe('x'.repeat(SLUG_BASE_MAX));
    expect(slugFromName(`${'a'.repeat(32)}-b`)).toBe('a'.repeat(32));
  });

  it('get the next numeric suffix after the highest in use', () => {
    expect(nextSlug('acme', [])).toBe('acme');
    expect(nextSlug('acme', ['acme-2'])).toBe('acme');
    expect(nextSlug('acme', ['acme'])).toBe('acme-2');
    expect(nextSlug('acme', ['acme', 'acme-2', 'acme-7', 'acme-corp', 'acme-08'])).toBe('acme-8');
    expect(nextSlug('x'.repeat(40), ['x'.repeat(40)])).toBe(`${'x'.repeat(38)}-2`);
    expect(() => nextSlug('No', [])).toThrow(TypeError);
  });

  it('always fit the CT-IDS slug pattern, whatever the name (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120, unit: 'grapheme' }), (name) => {
        const slug = slugFromName(name);
        expect(slug).toMatch(SLUG_PATTERN);
        expect(slug.length).toBeLessThanOrEqual(SLUG_BASE_MAX);
        expect(slug).not.toMatch(/^-|-$|--/);
      }),
      { numRuns: 500 },
    );
  });

  it('never repeat a taken slug, and stay in the pattern (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.array(fc.integer({ min: 2, max: 999_999 }), { maxLength: 20 }),
        fc.boolean(),
        (name, suffixes, baseTaken) => {
          const base = slugFromName(name);
          const taken = [...(baseTaken ? [base] : []), ...suffixes.map((n) => `${base}-${n}`)];
          const slug = nextSlug(base, taken);
          expect(taken).not.toContain(slug);
          expect(slug).toMatch(SLUG_PATTERN);
          if (!baseTaken) expect(slug).toBe(base);
        },
      ),
      { numRuns: 500 },
    );
  });
});
