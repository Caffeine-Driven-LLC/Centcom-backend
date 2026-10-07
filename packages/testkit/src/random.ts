/**
 * Seeded randomness (B010): a small deterministic generator (sfc32, seeded through cyrb128) so
 * tests that draw random data repeat exactly, and an id generator built on it. Tests only: it is
 * not a CSPRNG and must never produce a secret outside a test.
 *
 * Owns: the generator and the seeded id generator. Must not: read Math.random or the CSPRNG.
 */
import { createIdGenerator, type IdPrefix } from '@centcom/contracts';
import type { FakeClock } from './clock.js';

/** A deterministic source of random values. */
export interface SeededRandom {
  /** An unsigned 32-bit integer. */
  uint32(): number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** `n` characters drawn from `alphabet` (default a-z and 0-9). */
  string(n: number, alphabet?: string): string;
}

/** cyrb128: four 32-bit seeds from a string. */
function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A generator that gives the same sequence for the same seed, on every platform. */
export function createSeededRandom(seed: number | string): SeededRandom {
  let [a, b, c, d] = cyrb128(String(seed));
  const uint32 = (): number => {
    // sfc32
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Warm up: the first outputs of sfc32 still show the seed's structure.
  for (let i = 0; i < 12; i++) uint32();
  const next = (): number => uint32() / 4294967296;
  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError('int(min, max) takes integers with min <= max');
    }
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    uint32,
    next,
    int,
    bytes(n: number): Uint8Array {
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('bytes(n) takes a whole number');
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = uint32() & 0xff;
      return out;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick needs a non-empty list');
      return items[int(0, items.length - 1)] as T;
    },
    string(n: number, alphabet: string = ALPHANUMERIC): string {
      if (alphabet.length === 0) throw new RangeError('string needs a non-empty alphabet');
      let out = '';
      for (let i = 0; i < n; i++) out += alphabet.charAt(int(0, alphabet.length - 1));
      return out;
    },
  };
}

/**
 * CT-IDS ids from a seeded generator and a fake clock: the same seed and clock give the same ids
 * in the same order, still monotonic.
 */
export function seededIdGenerator(
  random: SeededRandom,
  clock: FakeClock,
): (prefix: IdPrefix) => string {
  return createIdGenerator({ now: clock.now, random: () => random.bytes(10) });
}
