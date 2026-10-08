/**
 * PKCE primitives (B018 acceptance 5, tests "pkce.test.ts"): the RFC 7636 Appendix B vector, the
 * verifier length and character bounds, a flipped character, malformed challenges, a property over
 * random verifiers, and that every comparison goes through the constant-time `timingSafeEqual`.
 */
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

const timing = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      timing.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { isCodeVerifier, isS256Challenge, s256, verifyS256 } =
  await import('../../../../src/modules/auth/pkce/pkce.js');

/** RFC 7636 Appendix B. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const flip = (text: string, at: number): string =>
  `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;

describe('S256', () => {
  it('passes the RFC 7636 Appendix B test vector', () => {
    expect(s256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(verifyS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('rejects a verifier with one character flipped, wherever it is', () => {
    for (const at of [0, 1, 21, 42]) {
      expect(verifyS256(flip(RFC_VERIFIER, at), RFC_CHALLENGE)).toBe(false);
    }
    expect(verifyS256(RFC_VERIFIER, flip(RFC_CHALLENGE, 10))).toBe(false);
  });

  it('accepts verifiers of 43 to 128 unreserved characters only', () => {
    const of = (length: number, ch = 'a'): string => ch.repeat(length);
    for (const length of [43, 64, 128]) {
      expect(isCodeVerifier(of(length))).toBe(true);
      expect(verifyS256(of(length), s256(of(length)))).toBe(true);
    }
    for (const length of [0, 42, 129]) {
      expect(isCodeVerifier(of(length))).toBe(false);
      expect(verifyS256(of(length), s256(of(length)))).toBe(false);
    }
    expect(isCodeVerifier(`${of(42)}-._~`)).toBe(true);
    for (const bad of ['+', '/', '=', ' ', '%', 'é']) {
      const verifier = `${of(42)}${bad}`;
      expect(isCodeVerifier(verifier)).toBe(false);
      expect(verifyS256(verifier, s256(verifier))).toBe(false);
    }
    expect(isCodeVerifier(42)).toBe(false);
  });

  it('answers false, never throws, for a malformed challenge', () => {
    expect(isS256Challenge(RFC_CHALLENGE)).toBe(true);
    for (const challenge of [
      '',
      RFC_CHALLENGE.slice(1),
      `${RFC_CHALLENGE}=`,
      `${RFC_CHALLENGE}A`,
    ]) {
      expect(isS256Challenge(challenge)).toBe(false);
      expect(verifyS256(RFC_VERIFIER, challenge)).toBe(false);
    }
    expect(isS256Challenge(undefined)).toBe(false);
  });

  it('matches a verifier with its own challenge and no other (property)', () => {
    const verifier = fc.stringMatching(/^[A-Za-z0-9\-._~]{43,128}$/);
    fc.assert(
      fc.property(verifier, verifier, (a, b) => {
        expect(verifyS256(a, s256(a))).toBe(true);
        expect(verifyS256(b, s256(a))).toBe(a === b);
      }),
      { numRuns: 200 },
    );
  });

  it('compares through timingSafeEqual (constant time)', () => {
    const before = timing.calls;
    verifyS256(RFC_VERIFIER, RFC_CHALLENGE);
    verifyS256(flip(RFC_VERIFIER, 3), RFC_CHALLENGE);
    expect(timing.calls - before).toBe(2);
  });
});
