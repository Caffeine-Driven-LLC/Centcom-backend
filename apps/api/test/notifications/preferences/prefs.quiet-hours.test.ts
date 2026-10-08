/**
 * Quiet hours (B066 acceptance 4, guardrail "validate the zone against the IANA database"): a
 * 22:00 to 07:00 window in Europe/Berlin is quiet at 23:30 and 06:59 local and not at 07:00; on the
 * DST changeover days of Europe/Berlin, America/New_York and Pacific/Auckland the instants are
 * right to the minute (a fixed offset would be an hour off); over every minute of those days the
 * window opens only at its local start and closes only at its local end. Properties over random
 * instants, zones and windows: a window and its complement split every instant; the result agrees
 * with B063's own quiet-hours clock; nothing throws, whatever the input. Zones are IANA names only:
 * offsets are refused even though `Intl` accepts them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { UserNotificationPrefs } from '../../../src/modules/notifications/dispatcher/ports.js';
import { quietHours } from '../../../src/modules/notifications/dispatcher/routing.js';
import {
  canonicalTimeZone,
  isQuietNow,
  localMinute,
  quietHoursPort,
} from '../../../src/modules/notifications/preferences/quiet-hours.js';

const window = (
  start: string,
  end: string,
  timezone: string,
  enabled = true,
): UserNotificationPrefs => ({
  channels: {},
  quiet_hours: { enabled, start, end, timezone },
});

const NIGHT_BERLIN = window('22:00', '07:00', 'Europe/Berlin');
const at = (iso: string): Date => new Date(iso);

describe('isQuietNow', () => {
  it.each([
    ['2026-07-14T21:30:00Z', true, '23:30 CEST'],
    ['2026-07-15T04:59:00Z', true, '06:59 CEST'],
    ['2026-07-15T05:00:00Z', false, '07:00 CEST'],
    ['2026-07-14T19:59:00Z', false, '21:59 CEST'],
    ['2026-07-14T20:00:00Z', true, '22:00 CEST'],
    ['2026-07-14T22:00:00Z', true, 'midnight CEST'],
    ['2026-01-14T22:30:00Z', true, '23:30 CET'],
    ['2026-01-15T05:59:00Z', true, '06:59 CET'],
    ['2026-01-15T06:00:00Z', false, '07:00 CET'],
  ])('22:00 to 07:00 in Berlin at %s is %s (%s)', (instant, quiet) => {
    expect(isQuietNow(NIGHT_BERLIN, at(instant))).toBe(quiet);
  });

  it.each([
    // Europe/Berlin: 02:00 CET → 03:00 CEST on 29 March, 03:00 CEST → 02:00 CET on 25 October.
    ['Europe/Berlin', '2026-03-28T22:30:00Z', true],
    ['Europe/Berlin', '2026-03-29T01:30:00Z', true],
    ['Europe/Berlin', '2026-03-29T04:59:00Z', true],
    ['Europe/Berlin', '2026-03-29T05:00:00Z', false],
    ['Europe/Berlin', '2026-10-24T19:59:00Z', false],
    ['Europe/Berlin', '2026-10-24T20:00:00Z', true],
    ['Europe/Berlin', '2026-10-25T05:00:00Z', true],
    ['Europe/Berlin', '2026-10-25T05:59:00Z', true],
    ['Europe/Berlin', '2026-10-25T06:00:00Z', false],
    // America/New_York: 02:00 EST → 03:00 EDT on 8 March, 02:00 EDT → 01:00 EST on 1 November.
    ['America/New_York', '2026-03-08T10:59:00Z', true],
    ['America/New_York', '2026-03-08T11:00:00Z', false],
    ['America/New_York', '2026-11-01T11:59:00Z', true],
    ['America/New_York', '2026-11-01T12:00:00Z', false],
    // Pacific/Auckland: 03:00 NZDT → 02:00 NZST on 5 April, 02:00 NZST → 03:00 NZDT on 27 September.
    ['Pacific/Auckland', '2026-04-04T18:59:00Z', true],
    ['Pacific/Auckland', '2026-04-04T19:00:00Z', false],
    ['Pacific/Auckland', '2026-09-26T17:59:00Z', true],
    ['Pacific/Auckland', '2026-09-26T18:00:00Z', false],
  ])('22:00 to 07:00 in %s at %s (a DST changeover day) is %s', (zone, instant, quiet) => {
    expect(isQuietNow(window('22:00', '07:00', zone), at(instant))).toBe(quiet);
  });

  it.each([
    ['Europe/Berlin', '2026-03-28T12:00:00Z'],
    ['Europe/Berlin', '2026-10-24T12:00:00Z'],
    ['America/New_York', '2026-03-07T17:00:00Z'],
    ['America/New_York', '2026-10-31T16:00:00Z'],
    ['Pacific/Auckland', '2026-04-04T00:00:00Z'],
    ['Pacific/Auckland', '2026-09-26T00:00:00Z'],
  ])(
    'over every minute around the changeover in %s, opens only at 22:00 and closes only at 07:00 local',
    (zone, from) => {
      const prefs = window('22:00', '07:00', zone);
      let previous = isQuietNow(prefs, at(from));
      const changes: string[] = [];
      for (let minute = 1; minute <= 36 * 60; minute += 1) {
        const instant = new Date(Date.parse(from) + minute * 60_000);
        const quiet = isQuietNow(prefs, instant);
        if (quiet !== previous) {
          const local = localMinute(instant, zone);
          changes.push(`${quiet ? 'on' : 'off'}@${local}`);
        }
        previous = quiet;
      }
      expect(changes.length).toBeGreaterThanOrEqual(2);
      for (const change of changes) expect(['on@1320', 'off@420']).toContain(change);
    },
  );

  it('handles a daytime window, and is off when disabled or unusable', () => {
    const lunch = window('12:00', '13:30', 'Asia/Tokyo');
    expect(isQuietNow(lunch, at('2026-05-01T03:00:00Z'))).toBe(true); // 12:00 JST
    expect(isQuietNow(lunch, at('2026-05-01T04:29:00Z'))).toBe(true); // 13:29
    expect(isQuietNow(lunch, at('2026-05-01T04:30:00Z'))).toBe(false); // 13:30
    expect(isQuietNow(lunch, at('2026-05-01T02:59:00Z'))).toBe(false); // 11:59
    const midnight = at('2026-07-14T22:00:00Z');
    expect(isQuietNow(window('22:00', '07:00', 'Europe/Berlin', false), midnight)).toBe(false);
    expect(isQuietNow(window('22:00', '22:00', 'Europe/Berlin'), midnight)).toBe(false);
    expect(isQuietNow(window('22:00', '07:00', 'Nowhere/Land'), midnight)).toBe(false);
    expect(isQuietNow(window('22:00', '07:00', '+02:00'), midnight)).toBe(false);
    expect(isQuietNow(window('25:00', '07:00', 'Europe/Berlin'), midnight)).toBe(false);
    expect(isQuietNow({ channels: {}, quiet_hours: { enabled: true } }, midnight)).toBe(false);
    expect(isQuietNow(NIGHT_BERLIN, new Date(Number.NaN))).toBe(false);
    expect(quietHoursPort.isQuiet(NIGHT_BERLIN, midnight)).toBe(true);
  });
});

describe('canonicalTimeZone', () => {
  it.each([
    ['Europe/Berlin', 'Europe/Berlin'],
    ['europe/berlin', 'Europe/Berlin'],
    ['America/New_York', 'America/New_York'],
    ['Pacific/Auckland', 'Pacific/Auckland'],
    ['UTC', 'UTC'],
    ['Etc/GMT+5', 'Etc/GMT+5'],
    ['+01:00', null],
    ['-0500', null],
    ['+0100', null],
    ['GMT+1', null],
    ['Mars/Base', null],
    ['', null],
    [' Europe/Berlin', null],
    [null, null],
    [42, null],
  ])('%j is %j', (value, canonical) => {
    expect(canonicalTimeZone(value)).toBe(canonical);
  });
});

const ZONES = [
  'Europe/Berlin',
  'America/New_York',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'Asia/Kathmandu',
  'UTC',
];
const hhmm = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
const instant = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
  .map((ms) => new Date(ms));

describe('quiet-hours properties', () => {
  it('a window and its complement split every instant', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), hhmm, hhmm, instant, (zone, start, end, now) => {
        fc.pre(start !== end);
        const one = isQuietNow(window(start, end, zone), now);
        const other = isQuietNow(window(end, start, zone), now);
        return one !== other;
      }),
      { numRuns: 2000 },
    );
  });

  it("agrees with B063's quiet-hours clock on valid windows", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), hhmm, hhmm, instant, (zone, start, end, now) => {
        const prefs = window(start, end, zone);
        return isQuietNow(prefs, now) === quietHours.isQuiet(prefs, now);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws, whatever the document holds', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.anything(),
        fc.anything(),
        instant,
        (enabled, start, end, timezone, now) => {
          const prefs = { channels: {}, quiet_hours: { enabled, start, end, timezone } };
          return typeof isQuietNow(prefs as unknown as UserNotificationPrefs, now) === 'boolean';
        },
      ),
      { numRuns: 1000 },
    );
  });
});
