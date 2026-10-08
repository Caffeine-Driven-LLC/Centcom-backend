/**
 * Key material (B019 acceptance 1 and 9; card test generate.test.ts): the CT-AUTH format, the
 * 12-character prefix, the peppered hash, rejection sampling, and over 1 000 000 keys a uniform
 * base62 distribution (chi-square, p > 0.001) with no repeats.
 */
import { createHash } from 'node:crypto';
import { Secret } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_SHAPE,
  BASE62,
  generateApiKey,
  hashApiKey,
  hashesEqual,
} from '../../../src/modules/apikeys/generate.js';
import { PEPPER } from './helpers.js';

describe('a key', () => {
  it.each(['live', 'test'] as const)('of mode %s matches cen_%s_ and 32 base62', (mode) => {
    const { key, prefix } = generateApiKey(mode);
    expect(key).toMatch(/^cen_(live|test)_[0-9A-Za-z]{32}$/);
    expect(key.startsWith(`cen_${mode}_`)).toBe(true);
    expect(API_KEY_SHAPE.test(key)).toBe(true);
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix).toHaveLength(12);
  });

  it('draws again on bytes that would bias base62 (248 and up)', () => {
    const calls = [
      [255, 248, 0, 61, 62, 247, ...Array<number>(58).fill(1)],
      Array<number>(64).fill(2),
    ];
    const { key } = generateApiKey('live', (size) =>
      Uint8Array.from((calls.shift() ?? []).slice(0, size)),
    );
    // 0 -> '0', 61 -> 'z', 62 -> '0' (62 % 62), 247 -> 'z' (247 % 62 = 61), then 1s.
    expect(key).toBe(`cen_live_0z0z${'1'.repeat(28)}`);
  });
});

describe('the stored hash', () => {
  it('is sha256(pepper ‖ key) in hex, and changes with the pepper (acceptance 1)', () => {
    const { key } = generateApiKey('live');
    const hash = hashApiKey(key, PEPPER);
    expect(hash).toBe(createHash('sha256').update(`${PEPPER.reveal()}${key}`).digest('hex'));
    expect(hash).not.toBe(createHash('sha256').update(key).digest('hex'));
    expect(hashApiKey(key, new Secret('another-pepper-0123456789abcdefghij'))).not.toBe(hash);
    expect(hash).not.toContain(key.slice(9));
  });

  it('compares in constant time, and only equal strings are equal', () => {
    const a = hashApiKey(generateApiKey('live').key, PEPPER);
    expect(hashesEqual(a, a)).toBe(true);
    expect(
      hashesEqual(
        a,
        a.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
      ),
    ).toBe(false);
    expect(hashesEqual(a, a.slice(1))).toBe(false);
  });
});

describe('1 000 000 keys (acceptance 9)', () => {
  it('are all different and spread evenly over base62 (chi-square, p > 0.001)', () => {
    const N = 1_000_000;
    const counts = new Array<number>(62).fill(0);
    const seen = new Set<string>();
    const index = new Map([...BASE62].map((ch, i) => [ch, i]));
    for (let i = 0; i < N; i++) {
      const random = generateApiKey('live').key.slice(9);
      seen.add(random);
      for (const ch of random) {
        const i = index.get(ch) ?? 0;
        counts[i] = (counts[i] ?? 0) + 1;
      }
    }
    expect(seen.size).toBe(N);
    const expected = (N * 32) / 62;
    const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // The 0.999 quantile of chi-square with 61 degrees of freedom (Wilson-Hilferty): about 100.9.
    expect(chi2).toBeLessThan(100.9);
  }, 120_000);
});
