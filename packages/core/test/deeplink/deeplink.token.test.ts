/**
 * Link tokens (B033, card test deeplink.token.test.ts, acceptance 3): 27 base64url characters, no
 * collision in 1 000 000 draws, the platform CSPRNG by default (and no Math.random anywhere in the
 * deep-link code), and a failing source throws instead of giving a weaker token.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  cryptoRandomSource,
  generateLinkToken,
  isLinkToken,
  LINK_TOKEN_BYTES,
  LINK_TTL,
  parseDeepLink,
  type RandomSource,
} from '../../src/index.js';

describe('generateLinkToken', () => {
  it('makes 27 base64url characters from 160 bits', () => {
    expect(LINK_TOKEN_BYTES * 8).toBe(160);
    for (let i = 0; i < 1000; i++) {
      const token = generateLinkToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{27}$/);
      expect(isLinkToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(LINK_TOKEN_BYTES);
      expect(parseDeepLink(`centcom://join/${token}`)).toMatchObject({ ok: true, token });
    }
  });

  it('gives no collision across 1 000 000 draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000_000; i++) seen.add(generateLinkToken());
    expect(seen.size).toBe(1_000_000);
  }, 120_000);

  it('draws from the CSPRNG by default, 20 bytes a token', () => {
    const spy = vi.spyOn(cryptoRandomSource, 'bytes');
    try {
      generateLinkToken();
      expect(spy).toHaveBeenCalledWith(LINK_TOKEN_BYTES);
    } finally {
      spy.mockRestore();
    }
  });

  it('writes exactly the bytes its source gives', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13);
    const source: RandomSource = { bytes: () => bytes };
    expect(generateLinkToken(source)).toBe(Buffer.from(bytes).toString('base64url'));
    // A view into a larger buffer: only its own 20 bytes.
    const big = new Uint8Array(64).fill(255);
    big.set(bytes, 7);
    expect(generateLinkToken({ bytes: () => big.subarray(7, 27) })).toBe(
      Buffer.from(bytes).toString('base64url'),
    );
  });

  it('throws, never falls back, when the source fails or gives the wrong bytes', () => {
    const failing: RandomSource = {
      bytes: () => {
        throw new Error('entropy source unavailable');
      },
    };
    expect(() => generateLinkToken(failing)).toThrow('entropy source unavailable');
    expect(() => generateLinkToken({ bytes: () => new Uint8Array(19) })).toThrow(/20 bytes/);
    expect(() => generateLinkToken({ bytes: () => new Uint8Array(21) })).toThrow(/20 bytes/);
    expect(() => generateLinkToken({ bytes: () => [1, 2, 3] as unknown as Uint8Array })).toThrow(
      /20 bytes/,
    );
  });
});

describe('LINK_TTL', () => {
  it('is 7 days for an invite and at most 24 h for a share link', () => {
    expect(LINK_TTL).toEqual({ invite_s: 7 * 24 * 3600, share_link_max_s: 24 * 3600 });
    expect(Object.isFrozen(LINK_TTL)).toBe(true);
  });
});

describe('the deep-link sources', () => {
  const dirs = [
    new URL('../../src/deeplink/', import.meta.url),
    new URL('../../../../apps/api/src/modules/deeplinks/', import.meta.url),
  ].map((url) => fileURLToPath(url));

  it('never use Math.random (tokens come from the CSPRNG only)', () => {
    const files = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(dir, name)),
    );
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/Math\s*\.\s*random|Math\[/);
    }
    expect(readFileSync(join(dirs[0] ?? '', 'token.ts'), 'utf8')).toMatch(
      /import \{ randomBytes \} from 'node:crypto'/,
    );
  });
});
