/**
 * Quota levels (B076, CT-ENTITLEMENTS §5): where a metered limit stands, in integer arithmetic.
 *
 * - `ok` below 80 %, `warn` from 80 % (exactly: `used × 100 ≥ limit × 80`), `reached` from 100 %
 *   (`used ≥ limit`). Products are BigInt, so no boundary is ever a floating-point comparison.
 * - A `null` limit is unlimited: never evaluated, always `ok`.
 * - A limit of 0 allows nothing: no use is `ok`, any use is `reached`; it never warns.
 * - `pct` is `floor(used × 100 / limit)` (100 for any use of a 0 limit), for transitions only:
 *   signals carry 80 or 100, never the use itself.
 *
 * Owns: the arithmetic. Must not: read usage or limits itself.
 */
import type { QuotaKey } from '../../usage/counters.js';

/** The metered limits (B075's quota keys). */
export type MeteredKey = QuotaKey;

/** Where a limit stands. */
export type QuotaLevel = 'ok' | 'warn' | 'reached';

/** The levels that signal, in the order they fire. */
export type SignalLevel = Exclude<QuotaLevel, 'ok'>;
export const SIGNAL_LEVELS: readonly SignalLevel[] = Object.freeze(['warn', 'reached']);

/** The warning threshold (CT-ENTITLEMENTS §5: 80 %; QUOTA_WARN_PCT must say so). */
export const WARN_PCT = 80;

/** A change of level found by an evaluation. */
export interface QuotaTransition {
  limit: MeteredKey;
  from: QuotaLevel;
  to: QuotaLevel;
  /** `floor(used × 100 / limit)` when evaluated. */
  pct: number;
}

const RANK: Readonly<Record<QuotaLevel, number>> = Object.freeze({ ok: 0, warn: 1, reached: 2 });

/** Orders levels: negative when `a` is below `b`. */
export const compareLevels = (a: QuotaLevel, b: QuotaLevel): number => RANK[a] - RANK[b];

/** The higher of two levels. */
export const maxLevel = (a: QuotaLevel, b: QuotaLevel): QuotaLevel =>
  compareLevels(a, b) >= 0 ? a : b;

const whole = (n: number, what: string): bigint => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number`);
  return BigInt(n);
};

/** The level of `used` against `limit` (null: unlimited). */
export function levelOf(used: number, limit: number | null): QuotaLevel {
  if (limit === null) return 'ok';
  const u = whole(used, 'used');
  const l = whole(limit, 'limit');
  if (l === 0n) return u > 0n ? 'reached' : 'ok';
  if (u >= l) return 'reached';
  return u * 100n >= l * BigInt(WARN_PCT) ? 'warn' : 'ok';
}

/** `floor(used × 100 / limit)`; 100 for any use of a 0 limit; 0 when unlimited. */
export function pctOf(used: number, limit: number | null): number {
  if (limit === null) return 0;
  const u = whole(used, 'used');
  const l = whole(limit, 'limit');
  if (l === 0n) return u > 0n ? 100 : 0;
  return Number((u * 100n) / l);
}

/**
 * The levels that signal on the way from `from` up to `to`, in order. A 0 limit never warns: only
 * `reached` fires for it.
 */
export function levelsToClaim(from: QuotaLevel, to: QuotaLevel, limit: number): SignalLevel[] {
  return SIGNAL_LEVELS.filter(
    (level) =>
      compareLevels(level, from) > 0 &&
      compareLevels(level, to) <= 0 &&
      !(level === 'warn' && limit === 0),
  );
}

/** The signalled levels above `to`, which a fall to `to` re-arms. */
export const levelsToRearm = (to: QuotaLevel): SignalLevel[] =>
  SIGNAL_LEVELS.filter((level) => compareLevels(level, to) > 0);
