/**
 * Periods (B075 acceptance 5 and 9, card test usage.period.test.ts): without a subscription the
 * UTC calendar month; with one, the entitlements' period, earlier ones stepping back by whole
 * months (day clamped to short months) or years, or by the period's own length otherwise; at
 * `end` exactly the next period has begun; a late instant finds the period it happened in.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  calendarMonth,
  periodOf,
  type UsagePeriod,
} from '../../../src/modules/usage/period.js';

const p = (start: string, end: string): UsagePeriod => ({
  start: new Date(start),
  end: new Date(end),
});
const iso = (period: UsagePeriod) => [period.start.toISOString(), period.end.toISOString()];

describe('periods', () => {
  it('uses the UTC calendar month without a subscription', () => {
    expect(iso(calendarMonth(new Date('2026-10-08T12:00:00Z')))).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
    expect(iso(periodOf(new Date('2026-12-31T23:59:59.999Z'), null))).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
    expect(iso(periodOf(new Date('2027-01-01T00:00:00.000Z'), null))[0]).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it("uses the subscription's period, and steps back by whole months for a late instant", () => {
    const current = p('2026-10-15T08:30:00Z', '2026-11-15T08:30:00Z');
    expect(periodOf(new Date('2026-10-20T00:00:00Z'), current)).toBe(current);
    expect(iso(periodOf(new Date('2026-10-15T08:29:59Z'), current))).toEqual([
      '2026-09-15T08:30:00.000Z',
      '2026-10-15T08:30:00.000Z',
    ]);
    expect(iso(periodOf(new Date('2026-07-01T00:00:00Z'), current))).toEqual([
      '2026-06-15T08:30:00.000Z',
      '2026-07-15T08:30:00.000Z',
    ]);
  });

  it('starts the next period at end exactly', () => {
    const current = p('2026-10-15T08:30:00Z', '2026-11-15T08:30:00Z');
    expect(iso(periodOf(new Date('2026-11-15T08:30:00Z'), current))).toEqual([
      '2026-11-15T08:30:00.000Z',
      '2026-12-15T08:30:00.000Z',
    ]);
    expect(periodOf(new Date('2026-11-15T08:29:59.999Z'), current)).toBe(current);
  });

  it('clamps an anchor on the 31st to short months, and handles yearly and odd-length periods', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    const jan = p('2026-01-31T00:00:00Z', '2026-02-28T00:00:00Z');
    expect(iso(periodOf(new Date('2025-12-31T10:00:00Z'), jan))).toEqual([
      '2025-12-31T00:00:00.000Z',
      '2026-01-31T00:00:00.000Z',
    ]);
    const yearly = p('2026-03-01T00:00:00Z', '2027-03-01T00:00:00Z');
    expect(iso(periodOf(new Date('2025-06-01T00:00:00Z'), yearly))).toEqual([
      '2025-03-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
    const fortnight = p('2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z');
    expect(iso(periodOf(new Date('2026-09-20T00:00:00Z'), fortnight))).toEqual([
      '2026-09-17T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);
  });

  it('always finds a period that holds the instant (property)', () => {
    const anchors = fc.date({
      min: new Date('2024-01-01Z'),
      max: new Date('2028-01-01Z'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(
        anchors,
        fc.constantFrom(1, 12),
        fc.date({
          min: new Date('2020-01-01Z'),
          max: new Date('2032-01-01Z'),
          noInvalidDate: true,
        }),
        (start, months, at) => {
          const current = { start, end: addMonths(start, months) };
          const period = periodOf(at, current);
          return period.start.getTime() <= at.getTime() && at.getTime() < period.end.getTime();
        },
      ),
      { numRuns: 1000 },
    );
  });
});
