/**
 * Threshold arithmetic (B076 test plan "unit: threshold boundaries (79.99, 80.00, 99.99, 100.00,
 * 100.01) for each metered key, integer arithmetic only"; guardrail "MUST compute percentages with
 * integer or BigInt math; never floating point equality at the 80/100 boundary"; acceptance 4 "a
 * limit of null never produces a signal; a limit of 0 on a count key produces no usage_warning"):
 *
 * - each boundary, exactly, for both keys: 79.99, 80.00, 99.99, 100.00 and 100.01 % of a 30 000
 *   hosted-minute limit (Team's) and of a 10 000 queue cap, where every one is a whole number of
 *   units; then Pro's 6 000 hosted minutes, where 79.99 % and 99.99 % are not whole units, so the
 *   nearest whole units on either side are used (4 799 = 79.98 %, 5 999 = 99.98 %, 6 001 =
 *   100.02 %); and limits where `used / limit` is not exact in floating point;
 * - huge counters (past 2^53 / 100) stay exact;
 * - null never evaluates; 0 goes straight from ok to reached;
 * - a property: the level agrees with exact rational comparison for any whole use and limit.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  levelOf,
  levelsToClaim,
  levelsToRearm,
  pctOf,
} from '../../../src/modules/billing/quota/levels.js';

describe('levelOf and pctOf', () => {
  it.each([
    ['hosted_minutes_month', 30_000],
    ['queue_items_month', 10_000],
  ])('puts %s (limit %d) on the right side of every boundary', (_key, limit) => {
    // 79.99 %, 80.00 %, 99.99 %, 100.00 %, 100.01 %: whole units of use at these limits.
    const at = (hundredths: number) => {
      expect((limit * hundredths) % 10_000).toBe(0);
      return (limit * hundredths) / 10_000;
    };
    const cases: [number, string, number][] = [
      [at(7999), 'ok', 79],
      [at(8000), 'warn', 80],
      [at(9999), 'warn', 99],
      [at(10_000), 'reached', 100],
      [at(10_001), 'reached', 100],
    ];
    for (const [used, level, pct] of cases) {
      expect(levelOf(used, limit), `${used}/${limit}`).toBe(level);
      expect(pctOf(used, limit), `${used}/${limit}`).toBe(pct);
    }
  });

  it('puts the whole units around each boundary of 6 000 hosted minutes on the right side', () => {
    const cases: [number, string, number][] = [
      [4799, 'ok', 79], // 79.98 %
      [4800, 'warn', 80],
      [5999, 'warn', 99], // 99.98 %
      [6000, 'reached', 100],
      [6001, 'reached', 100], // 100.02 %
    ];
    for (const [used, level, pct] of cases) {
      expect(levelOf(used, 6000), `${used}/6000`).toBe(level);
      expect(pctOf(used, 6000), `${used}/6000`).toBe(pct);
    }
  });

  it('never rounds across a boundary with limits that do not divide evenly', () => {
    // 80 % of 7 is 5.6: 5 is below, 6 is above; 0.8 × 3 = 2.4000000000000004 in floating point.
    expect(levelOf(5, 7)).toBe('ok');
    expect(levelOf(6, 7)).toBe('warn');
    expect(levelOf(2, 3)).toBe('ok');
    expect(levelOf(3, 3)).toBe('reached');
    expect(levelOf(4, 5)).toBe('warn');
    expect(levelOf(79_999_999, 100_000_000)).toBe('ok');
    expect(levelOf(80_000_000, 100_000_000)).toBe('warn');
    const big = Number.MAX_SAFE_INTEGER;
    expect(levelOf(big - 1, big)).toBe('warn');
    expect(levelOf(big, big)).toBe('reached');
    expect(pctOf(big - 1, big)).toBe(99);
  });

  it('never evaluates a null limit, and takes a 0 limit straight to reached', () => {
    expect(levelOf(1_000_000, null)).toBe('ok');
    expect(pctOf(1_000_000, null)).toBe(0);
    expect(levelOf(0, 0)).toBe('ok');
    expect(levelOf(1, 0)).toBe('reached');
    expect(pctOf(1, 0)).toBe(100);
    expect(levelsToClaim('ok', 'reached', 0)).toEqual(['reached']);
    expect(levelsToClaim('ok', 'reached', 10)).toEqual(['warn', 'reached']);
    expect(levelsToClaim('warn', 'reached', 10)).toEqual(['reached']);
    expect(levelsToClaim('ok', 'warn', 10)).toEqual(['warn']);
    expect(levelsToRearm('ok')).toEqual(['warn', 'reached']);
    expect(levelsToRearm('warn')).toEqual(['reached']);
    expect(levelsToRearm('reached')).toEqual([]);
  });

  it('refuses use or limits that are not whole numbers', () => {
    expect(() => levelOf(1.5, 10)).toThrow(RangeError);
    expect(() => levelOf(-1, 10)).toThrow(RangeError);
    expect(() => levelOf(1, Number.NaN)).toThrow(RangeError);
  });

  it('agrees with exact rational comparison for any whole use and limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (used, limit) => {
          const u = BigInt(used);
          const l = BigInt(limit);
          const expected = u >= l ? 'reached' : u * 5n >= l * 4n ? 'warn' : 'ok';
          expect(levelOf(used, limit)).toBe(expected);
          expect(pctOf(used, limit)).toBe(Number((u * 100n) / l));
        },
      ),
      { numRuns: 500 },
    );
  });
});
