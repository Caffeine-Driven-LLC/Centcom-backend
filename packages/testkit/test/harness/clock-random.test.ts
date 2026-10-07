/**
 * Fake clock and seeded randomness (B010 acceptance 6, and the determinism behind 4): the clock
 * moves exactly as told and never reads real time; the same seed gives the same numbers, bytes
 * and ids on every run and platform.
 */
import { isId } from '@centcom/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeClock,
  createSeededRandom,
  DEFAULT_FAKE_TIME,
  seededIdGenerator,
} from '../../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFakeClock', () => {
  it('starts at DEFAULT_FAKE_TIME or the given time', () => {
    expect(new Date(createFakeClock().now()).toISOString()).toBe(DEFAULT_FAKE_TIME);
    expect(createFakeClock('2026-10-07T12:00:00.000Z').date().toISOString()).toBe(
      '2026-10-07T12:00:00.000Z',
    );
  });

  it('advance(1000) moves now() by exactly 1000 and never reads real time (acceptance 6)', () => {
    const clock = createFakeClock();
    const realNow = vi.spyOn(Date, 'now');
    const realPerf = vi.spyOn(performance, 'now');
    const before = clock.now();
    clock.advance(1000);
    expect(clock.now() - before).toBe(1000);
    clock.advance(0.5);
    clock.advance(-0.5);
    expect(clock.now() - before).toBe(1000);
    clock.set('2030-01-01T00:00:00.000Z');
    expect(clock.date().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(realNow).not.toHaveBeenCalled();
    expect(realPerf).not.toHaveBeenCalled();
  });

  it('stands still while real time passes, and works unbound', async () => {
    const clock = createFakeClock();
    const { now } = clock;
    const first = now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(now()).toBe(first);
  });

  it('refuses times that are not times', () => {
    expect(() => createFakeClock('yesterday')).toThrow(RangeError);
    const clock = createFakeClock();
    expect(() => clock.set('')).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.advance(Infinity)).toThrow(RangeError);
  });
});

describe('createSeededRandom', () => {
  it('gives the same sequence for the same seed, and these known values for "centcom"', () => {
    const a = createSeededRandom('centcom');
    const b = createSeededRandom('centcom');
    const first = Array.from({ length: 5 }, () => a.uint32());
    expect(Array.from({ length: 5 }, () => b.uint32())).toEqual(first);
    // Pinned: test data built from this seed must not change between releases or platforms.
    expect(first).toEqual(KNOWN_CENTCOM_VALUES);
  });

  it('gives different sequences for different seeds, and takes numbers as seeds', () => {
    const a = Array.from({ length: 4 }, createSeededRandom('one').uint32);
    const b = Array.from({ length: 4 }, createSeededRandom('two').uint32);
    expect(a).not.toEqual(b);
    expect(createSeededRandom(42).uint32()).toBe(createSeededRandom('42').uint32());
  });

  it('draws floats in [0, 1) and integers within inclusive bounds, reaching both ends', () => {
    const random = createSeededRandom('ranges');
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const f = random.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = random.int(-2, 2);
      expect(Number.isInteger(n) && n >= -2 && n <= 2).toBe(true);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([-1, -2, 0, 1, 2].sort());
  });

  it('draws bytes, picks and strings', () => {
    const random = createSeededRandom('shapes');
    const bytes = random.bytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    expect(['a', 'b', 'c']).toContain(random.pick(['a', 'b', 'c']));
    expect(random.string(16)).toMatch(/^[a-z0-9]{16}$/);
    expect(random.string(8, 'XY')).toMatch(/^[XY]{8}$/);
    expect(random.bytes(0)).toHaveLength(0);
  });

  it('refuses arguments it cannot honour', () => {
    const random = createSeededRandom('errors');
    expect(() => random.int(3, 1)).toThrow(RangeError);
    expect(() => random.int(0.5, 1)).toThrow(RangeError);
    expect(() => random.bytes(-1)).toThrow(RangeError);
    expect(() => random.pick([])).toThrow(RangeError);
    expect(() => random.string(3, '')).toThrow(RangeError);
  });
});

describe('seededIdGenerator', () => {
  it('makes the same valid, increasing CT-IDS ids for the same seed and clock', () => {
    const make = (): string[] => {
      const clock = createFakeClock();
      const ids = seededIdGenerator(createSeededRandom('ids'), clock);
      const out = [ids('usr'), ids('usr')];
      clock.advance(5);
      out.push(ids('wsp'));
      return out;
    };
    const run = make();
    expect(make()).toEqual(run);
    expect(isId('usr', run[0])).toBe(true);
    expect(isId('wsp', run[2])).toBe(true);
    expect((run[0] ?? '') < (run[1] ?? '')).toBe(true);
  });
});

/** The first five uint32 values of createSeededRandom('centcom'), pinned. */
const KNOWN_CENTCOM_VALUES: number[] = [4283108327, 2121283066, 3370726577, 437976026, 1911776950];
