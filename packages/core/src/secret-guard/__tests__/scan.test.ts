/**
 * Scanning and redaction (B101): caps, unicode, overlap removal, and the properties that a
 * redacted text matches no pattern and that scanning is idempotent.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createAllowList } from '../allow.js';
import { loadPatterns } from '../patterns.js';
import { isMarker, redactJson, redactText } from '../redact.js';
import { MAX_JSON_DEPTH, MAX_JSON_NODES, ScanLimitError, scanJson, scanText } from '../scan.js';
import { ANTHROPIC_KEY, AWS_KEY, BEARER_LINE, JWT } from '../../../test/secret-guard/helpers.js';

describe('scanText', () => {
  it('reports offsets in UTF-16 units, after multi-byte text', () => {
    const text = `\u{1F600} café ${AWS_KEY}`;
    expect(scanText(text)).toEqual([
      { pattern: 'aws_access_key', offset: text.indexOf('AKIA'), length: 20 },
    ]);
  });

  it('gives one hit for a string two patterns match (an anthropic key is also an openai-shaped one)', () => {
    expect(scanText(ANTHROPIC_KEY).map((h) => h.pattern)).toEqual(['anthropic_api_key']);
  });

  it('finds a JWT, a codex auth.json field and a Bearer header, each once', () => {
    const json = `{"access_token": "${'x'.repeat(30)}"}`;
    expect(scanText(JWT).map((h) => h.pattern)).toEqual(['openai_oauth_access']);
    expect(scanText(json).map((h) => h.pattern)).toEqual(['codex_auth_json']);
    expect(scanText(`${BEARER_LINE}\n`).map((h) => h.pattern)).toEqual(['bearer_header']);
  });

  it('does not match a key glued to a word (the contract lookbehind)', () => {
    expect(scanText(`x${ANTHROPIC_KEY}`)).toEqual([]);
  });

  it('reports a long token once, at its start, with its full length', () => {
    const long = `sk-${'a'.repeat(200_000)}`;
    expect(scanText(` ${long}`)).toEqual([
      { pattern: 'openai_api_key', offset: 1, length: long.length },
    ]);
  });
});

describe('scanJson', () => {
  it('walks arrays, objects and errors, and skips numbers, dates and buffers', () => {
    const err = Object.assign(new Error(`failed with ${AWS_KEY}`), { extra: { k: ANTHROPIC_KEY } });
    const hits = scanJson({
      list: [1, null, true, new Date(), Buffer.from(AWS_KEY)],
      err,
    });
    // the error's stack repeats its message, so its key is found in both
    expect(new Set(hits.map((h) => h.pattern))).toEqual(
      new Set(['anthropic_api_key', 'aws_access_key']),
    );
  });

  it('stops at depth 32 and at 100 000 nodes, and at the deadline', () => {
    let deep: unknown = AWS_KEY;
    for (let i = 0; i < MAX_JSON_DEPTH + 1; i++) deep = { n: deep };
    expect(() => scanJson(deep)).toThrow(ScanLimitError);
    let ok: unknown = AWS_KEY;
    for (let i = 0; i < MAX_JSON_DEPTH - 1; i++) ok = { n: ok };
    expect(scanJson(ok)).toHaveLength(1);
    expect(() => scanJson(new Array<number>(MAX_JSON_NODES + 1).fill(1))).toThrow(/nodes/);
    expect(() => scanJson(new Array<string>(50_000).fill('hello world'), { budgetMs: 0 })).toThrow(
      /budget/,
    );
  });

  it('survives a cycle', () => {
    const a: Record<string, unknown> = { s: AWS_KEY };
    a['self'] = a;
    expect(scanJson(a)).toHaveLength(1);
  });

  it('never returns the matched text: a hit holds only pattern, offset and length', () => {
    const [hit] = scanJson({ k: ANTHROPIC_KEY });
    expect(Object.keys(hit ?? {}).sort()).toEqual(['length', 'offset', 'pattern']);
  });
});

describe('redaction', () => {
  it('replaces each match with [redacted:<pattern id>] and keeps the rest', () => {
    expect(redactText(`x ${ANTHROPIC_KEY} y ${AWS_KEY}.`)).toBe(
      'x [redacted:anthropic_api_key] y [redacted:aws_access_key].',
    );
  });

  it('copies deeply, redacts keys, and does not touch the input', () => {
    const input = { [AWS_KEY]: { token: ANTHROPIC_KEY }, list: [ANTHROPIC_KEY] };
    const before = JSON.stringify(input);
    const out = redactJson(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(out)).not.toMatch(/AKIA|sk-ant/);
    expect(out).toEqual({
      '[redacted:aws_access_key]': { token: '[redacted:anthropic_api_key]' },
      list: ['[redacted:anthropic_api_key]'],
    });
    expect(isMarker('[redacted:aws_access_key]')).toBe(true);
    expect(isMarker('[redacted] sk')).toBe(false);
  });

  it('turns an Error into a plain object without the secret', () => {
    const out = redactJson({ err: new Error(`bad ${AWS_KEY}`) });
    expect(JSON.stringify(out)).not.toContain('AKIA');
    expect((out.err as { message: string }).message).toBe('bad [redacted:aws_access_key]');
  });

  it('property: redacted text matches no pattern, and scanning it again finds nothing', () => {
    const piece = fc.constantFrom(
      ANTHROPIC_KEY,
      AWS_KEY,
      BEARER_LINE,
      JWT,
      'sk-',
      'sk-proj-',
      'eyJ',
      '.',
      ' ',
      'x',
      '"access_token":"',
      'a'.repeat(40),
      '\n',
      '-',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), (parts) => {
        const redacted = redactText(parts.join(''));
        expect(scanText(redacted)).toEqual([]);
        for (const p of loadPatterns())
          expect(new RegExp(p.regex.source).test(redacted), p.id).toBe(false);
      }),
      { numRuns: 800 },
    );
  });
});

describe('scanText with an allow-list', () => {
  const allow = createAllowList({
    entries: [
      {
        pattern_id: 'aws_access_key',
        scope: 'path',
        value: 'docs/',
        reason: 'examples',
        expires: '2999-01-01',
      },
    ],
  });
  it('hides an allowed pattern at its location only', () => {
    expect(scanText(AWS_KEY, { allow, location: { path: 'docs/x.md' } })).toEqual([]);
    expect(scanText(AWS_KEY, { allow, location: { path: 'src/x.ts' } })).toHaveLength(1);
    expect(scanText(AWS_KEY, { allow })).toHaveLength(1);
  });
});
