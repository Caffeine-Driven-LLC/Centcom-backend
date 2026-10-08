/**
 * Quiet hours (B066, CT-NOTIF-PAYLOAD "Quiet hours suppress push and os"): whether a user's quiet
 * window is on at an instant, read in the user's IANA time zone through the platform's time zone
 * database, so overnight windows and DST changeovers come out right. The window is [start, end) in
 * local wall-clock time and may cross midnight.
 *
 * - `canonicalTimeZone` accepts IANA zone names only (case-insensitively, returning the canonical
 *   spelling) and refuses UTC offsets such as `+01:00`, which `Intl` would otherwise accept.
 * - `isQuietNow` is false for a window that is off, has no zone or times, has equal start and end,
 *   or names a zone the platform does not know: an unusable window never suppresses anything.
 * - `quietHoursPort` is B063's `QuietHoursPort` on this rule.
 *
 * Which categories quiet hours may suppress is B063's routing (`decideChannels`): never
 * `security_alert` or `billing_issue`.
 *
 * Owns: the clock arithmetic. Must not: trust an offset the client sends, or throw.
 */
import type { QuietHoursPort, UserNotificationPrefs } from '../dispatcher/ports.js';

/** `HH:MM`, 00:00 to 23:59. */
export const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Longest time zone name accepted. */
export const MAX_TIME_ZONE_LENGTH = 64;

/** Zone names: letters first, then letters, digits, `_`, `-`, `+` and `/`; never an offset. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/** Formatters by canonical zone; bounded by the size of the time zone database. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The canonical IANA name of `value`, or null when it is not one (offsets are not). */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TIME_ZONE_LENGTH || !ZONE_NAME.test(value)) {
    return null;
  }
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-GB', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return ZONE_NAME.test(resolved) ? resolved : null;
}

/** Minutes since local midnight of `hhmm`, or null when it is not `HH:MM`. */
export function minutesOf(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string') return null;
  const m = HH_MM.exec(hhmm);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}

/** The local minute of the day at `now` in `timeZone` (a canonical name). */
export function localMinute(now: Date, timeZone: string): number {
  let hour = 0;
  let minute = 0;
  for (const part of formatter(timeZone).formatToParts(now)) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** Whether the user's quiet hours are on at `now`. */
export function isQuietNow(prefs: UserNotificationPrefs, now: Date): boolean {
  const q = prefs.quiet_hours;
  if (q.enabled !== true) return false;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  const zone = canonicalTimeZone(q.timezone);
  if (start === null || end === null || start === end || zone === null) return false;
  if (Number.isNaN(now.getTime())) return false;
  const t = localMinute(now, zone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** B063's `QuietHoursPort` on `isQuietNow`. */
export const quietHoursPort: QuietHoursPort = { isQuiet: isQuietNow };
