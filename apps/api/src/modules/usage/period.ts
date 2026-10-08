/**
 * Usage periods (B075): the window counters and quotas reset on.
 *
 * - A subscribed workspace uses its entitlements' `period` (B069, Stripe's billing period).
 * - Every other workspace uses the calendar month in UTC.
 * - An instant before the current period belongs to an earlier one. Earlier periods step back from
 *   the current one by its length in whole months (1 or 12, keeping the anchor's day and time and
 *   clamping to short months, as Stripe does), or by its exact length when it is not whole months.
 *   So a late event lands in the period it happened in.
 *
 * Periods are [start, end): at `end` exactly, the next period has begun.
 *
 * Owns: the period arithmetic. Must not: read Stripe or plan names.
 */

/** A period: `start` inclusive, `end` exclusive. */
export interface UsagePeriod {
  start: Date;
  end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar month holding `at`. */
export function calendarMonth(at: Date): UsagePeriod {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { start: new Date(start), end: new Date(end) };
}

/** `anchor` moved by `months` months, its day clamped to the target month's length. */
export function addMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The period's length in whole months (1 or 12), or null when it is not one. */
function wholeMonths(period: UsagePeriod): number | null {
  for (const months of [1, 12]) {
    if (addMonths(period.start, months).getTime() === period.end.getTime()) return months;
  }
  return null;
}

/**
 * The period holding `at`: in `current`'s series when the workspace is subscribed (`current` not
 * null), else its calendar month.
 */
export function periodOf(at: Date, current: UsagePeriod | null): UsagePeriod {
  if (current === null) return calendarMonth(at);
  const t = at.getTime();
  if (t >= current.start.getTime() && t < current.end.getTime()) return current;
  const months = wholeMonths(current);
  if (months === null) {
    const length = Math.max(DAY_MS, current.end.getTime() - current.start.getTime());
    const k = Math.floor((t - current.start.getTime()) / length);
    const start = current.start.getTime() + k * length;
    return { start: new Date(start), end: new Date(start + length) };
  }
  // Step by whole periods from the anchor; months stay anchored to its day (clamped).
  let k = Math.floor(
    ((at.getUTCFullYear() - current.start.getUTCFullYear()) * 12 +
      (at.getUTCMonth() - current.start.getUTCMonth())) /
      months,
  );
  for (;;) {
    const start = addMonths(current.start, k * months);
    const end = addMonths(current.start, (k + 1) * months);
    if (t < start.getTime()) k -= 1;
    else if (t >= end.getTime()) k += 1;
    else return { start, end };
  }
}

/** The period `now` is in for a workspace whose entitlements' period is `subscribed`. */
export function currentPeriod(subscribed: UsagePeriod | null, now: Date): UsagePeriod {
  return periodOf(now, subscribed);
}
