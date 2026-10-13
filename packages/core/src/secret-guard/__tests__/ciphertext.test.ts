/**
 * Ciphertext rule (B101, CT-CRYPTO): the module holds no key material and imports nothing that
 * decrypts, decodes or reads keys.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..');
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, text: readFileSync(join(DIR, f), 'utf8') }));

describe('secret-guard sources', () => {
  it('import no crypto, no base64 decoding of payloads, and no key material', () => {
    for (const { f, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(
        /node:crypto|from 'crypto'|createDecipher|subtle\.|@noble|sodium/,
      );
      expect(code, f).not.toMatch(/atob\(|from\('[^']*',\s*'base64/);
      expect(code, f).not.toMatch(/process\.env|\.reveal\(\)/);
    }
  });

  it('only frame.ts mentions ct, and only to leave it out', () => {
    const mentions = sources.filter(({ text }) =>
      /\['ct'\]|\.ct\b|'ct'/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')),
    );
    expect(mentions.map((m) => m.f)).toEqual(['frame.ts']);
  });
});
