/**
 * Wire timestamps (CT-IDS): RFC 3339, UTC, `Z` suffix, exactly millisecond precision,
 * e.g. `2026-10-05T18:07:41.123Z`.
 *
 * Owns: formatting and strict parsing of wire timestamps. Must not: accept offsets, missing
 * milliseconds or impossible dates, or throw on external input (parse returns null).
 */

const WIRE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Formats a Date as a wire timestamp. Throws RangeError for an invalid Date or a year outside
 * 0000-9999 (a programming error, never external input).
 */
export function formatTimestamp(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new RangeError('cannot format an invalid Date');
  const s = d.toISOString();
  if (!WIRE_TIMESTAMP.test(s)) throw new RangeError(`year outside 0000-9999: ${s}`);
  return s;
}

/**
 * Parses a wire timestamp. Returns null unless the value is exactly `YYYY-MM-DDTHH:mm:ss.sssZ`
 * and names a real instant (no `2026-02-30`, no leap second). Never throws.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length !== 24 || !WIRE_TIMESTAMP.test(value)) return null;
  const d = new Date(value);
  // Date normalises impossible dates (Feb 30 -> Mar 2); a round trip catches that.
  return !Number.isNaN(d.getTime()) && d.toISOString() === value ? d : null;
}

/** True if `value` is a valid wire timestamp. */
export function isTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== null;
}
