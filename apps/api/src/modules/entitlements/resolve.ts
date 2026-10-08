/**
 * The entitlement resolver (B069, CT-ENTITLEMENTS §4): a pure function from a workspace's
 * subscription state, its plan's limits and the time to what the workspace may do.
 *
 * - `active` and `trialing`: the plan's limits (a trial is its plan's).
 * - `past_due`: the plan's limits until `grace_until` (7 days after the payment failed), then
 *   `none`.
 * - `canceled`: the plan's limits until `period.end`, then `none`; without a period, `none`.
 * - `none`: the free plan's limits, with no period.
 *
 * Team's seats grow by the add-on seats; `lan_multiplayer` is always true. Limits come only from
 * the catalog (the `plan_limits` rows) and the add-on seats.
 *
 * Owns: those rules and the digest `rev` follows. Must not: read the clock, the database or
 * Stripe, or add a limit key.
 */
import { createHash } from 'node:crypto';
import {
  ENTITLEMENT_STATUSES,
  FLAG_KEYS,
  isEntitlementStatus,
  isPlanId,
  LIMIT_KEYS,
  NULLABLE_KEYS,
  type EntitlementLimits,
  type EntitlementStatus,
  type Period,
  type PlanId,
} from './ports.js';

/** Days of grace a past-due subscription keeps its plan. */
export const GRACE_DAYS = 7;
/** The same, in milliseconds. */
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
/** Add-on seats one workspace may hold. */
export const MAX_ADDON_SEATS = 100_000;
/** The plans whose seats grow with add-on seats. */
export const ADDON_SEAT_PLANS: ReadonlySet<PlanId> = new Set(['team']);

/** What is wrong with a state or a catalog. */
export type EntitlementErrorCode =
  'unknown_plan' | 'unknown_status' | 'addon_seats' | 'period' | 'grace' | 'time' | 'catalog';

/** A state the resolver cannot resolve; nothing built from it may be stored. */
export class EntitlementError extends Error {
  override readonly name = 'EntitlementError';
  constructor(
    readonly code: EntitlementErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Each plan's limits, as the `plan_limits` rows give them. */
export type PlanCatalog = ReadonlyMap<PlanId, Readonly<EntitlementLimits>>;

/** What the resolver reads. */
export interface ResolveInput {
  plan: string;
  status: string;
  period: Period | null;
  /** Set for `past_due`: when its grace ends (`graceUntilFor(past_due_since)`). */
  grace_until: Date | null;
  addonSeats: number;
  now: Date;
}

/** A resolved entitlement: the effective plan, status and limits. */
export interface Resolved {
  plan: PlanId;
  status: EntitlementStatus;
  limits: EntitlementLimits;
  period: Period | null;
  grace_until: Date | null;
}

/** When the grace of a subscription past due since `pastDueSince` ends. */
export function graceUntilFor(pastDueSince: Date): Date {
  if (!validDate(pastDueSince)) throw new EntitlementError('grace', 'past_due_since is not a time');
  return new Date(pastDueSince.getTime() + GRACE_MS);
}

/** The effective entitlement of `input` under `catalog`; an EntitlementError for a bad input. */
export function resolveEntitlements(input: ResolveInput, catalog: PlanCatalog): Resolved {
  const { plan, status, period, grace_until: grace, addonSeats, now } = input;
  if (!isPlanId(plan)) throw new EntitlementError('unknown_plan', 'unknown plan');
  if (!isEntitlementStatus(status)) {
    throw new EntitlementError(
      'unknown_status',
      `status must be one of ${ENTITLEMENT_STATUSES.join(', ')}`,
    );
  }
  checkAddonSeats(addonSeats);
  if (!validDate(now)) throw new EntitlementError('time', 'now is not a time');
  if (period !== null) checkPeriod(period);
  if (status === 'past_due' && (grace === null || !validDate(grace))) {
    throw new EntitlementError('grace', 'a past_due state needs grace_until');
  }
  if (status !== 'past_due' && grace !== null) {
    throw new EntitlementError('grace', 'only a past_due state has grace_until');
  }
  const at = now.getTime();
  const keepsPlan =
    status === 'active' ||
    status === 'trialing' ||
    (status === 'past_due' && grace !== null && at <= grace.getTime()) ||
    (status === 'canceled' && period !== null && at <= period.end.getTime());
  if (!keepsPlan) {
    return {
      plan: 'free',
      status: 'none',
      limits: limitsOf(catalog, 'free'),
      period: null,
      grace_until: null,
    };
  }
  const limits = limitsOf(catalog, plan);
  if (ADDON_SEAT_PLANS.has(plan) && limits.max_seats !== null) limits.max_seats += addonSeats;
  return { plan, status, limits, period, grace_until: status === 'past_due' ? grace : null };
}

/** Throws unless `seats` is a whole number of add-on seats a workspace may hold. */
export function checkAddonSeats(seats: unknown): asserts seats is number {
  if (typeof seats !== 'number' || !Number.isSafeInteger(seats) || seats < 0) {
    throw new EntitlementError('addon_seats', 'add-on seats must be a whole number, 0 or more');
  }
  if (seats > MAX_ADDON_SEATS) {
    throw new EntitlementError('addon_seats', `add-on seats are at most ${MAX_ADDON_SEATS}`);
  }
}

/** Throws unless `period` runs from a time to a later one. */
export function checkPeriod(period: Period): void {
  if (!validDate(period.start) || !validDate(period.end) || period.end <= period.start) {
    throw new EntitlementError('period', 'a period runs from start to a later end');
  }
}

/**
 * The digest `rev` follows: sha256 over the plan, status and limits (keys in the contract's
 * order). The period and grace are left out, so a renewal does not move `rev`.
 */
export function resolvedDigest(resolved: Pick<Resolved, 'plan' | 'status' | 'limits'>): Buffer {
  const limits = LIMIT_KEYS.map((key) => [key, resolved.limits[key]]);
  return createHash('sha256')
    .update(JSON.stringify([resolved.plan, resolved.status, limits]))
    .digest();
}

/** The limits of `plan` (a copy); an EntitlementError when the catalog lacks one. */
function limitsOf(catalog: PlanCatalog, plan: PlanId): EntitlementLimits {
  const limits = catalog.get(plan);
  if (limits === undefined) throw new EntitlementError('catalog', `no limits for plan ${plan}`);
  checkLimits(plan, limits);
  return { ...limits, lan_multiplayer: true };
}

/** Throws unless `limits` has every key with a value of its type. */
export function checkLimits(plan: string, limits: Readonly<Record<string, unknown>>): void {
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    const ok = FLAG_KEYS.has(key)
      ? typeof value === 'boolean'
      : (value === null && NULLABLE_KEYS.has(key)) ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    if (!ok)
      throw new EntitlementError('catalog', `plan ${plan}: limit ${key} is missing or invalid`);
  }
  if (limits['lan_multiplayer'] !== true) {
    throw new EntitlementError('catalog', `plan ${plan}: lan_multiplayer must be true`);
  }
}

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
