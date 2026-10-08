/**
 * The plan seed (B069): CT-ENTITLEMENTS §3's reference limits and the plans' prices. The limits
 * here and the rows migration 20260102001500_plans_entitlements.sql seeds are kept equal by a
 * test; the service reads limits from those rows only. Prices are product decisions and live only
 * here: integer minor units, in USD and EUR.
 *
 * `validateSeedPlans` runs when the service starts: an unknown plan or limit key, a missing plan
 * or limit, or a malformed price stops the boot.
 *
 * Owns: the seed and its validation. Must not: add a limit key (a contract change), or hold a
 * price as anything but integer minor units.
 */
import type { Api } from '@centcom/contracts';
import { checkLimits, EntitlementError } from './resolve.js';
import { isPlanId, LIMIT_KEYS, PLAN_IDS, type EntitlementLimits, type PlanId } from './ports.js';

/** One price of a plan. */
export type SeedPrice = Api.Plan['prices'][number];

/** One plan of the seed. */
export interface SeedPlan {
  name: string;
  prices: readonly SeedPrice[];
  limits: EntitlementLimits;
}

/** The seed: every plan, exactly. */
export type SeedPlans = Readonly<Record<PlanId, SeedPlan>>;

/** Why a seed was refused. */
export class SeedPlansError extends Error {
  override readonly name = 'SeedPlansError';
}

const CURRENCIES: readonly Api.Money['currency'][] = ['USD', 'EUR'];
const INTERVALS: readonly SeedPrice['interval'][] = ['month', 'year'];
const UNITS: readonly NonNullable<SeedPrice['unit']>[] = ['seat', 'workspace'];

/** Monthly prices of `unit`, in cents. */
const monthly = (unit: 'seat' | 'workspace', usd: number, eur: number): SeedPrice[] => [
  { interval: 'month', unit, price: { amount: usd, currency: 'USD' } },
  { interval: 'month', unit, price: { amount: eur, currency: 'EUR' } },
];

/** The reference seed (CT-ENTITLEMENTS §3); the prices are placeholders for product to set. */
export const SEED_PLANS: SeedPlans = deepFreeze({
  free: {
    name: 'Free',
    prices: monthly('workspace', 0, 0),
    limits: {
      relay_access: false,
      lan_multiplayer: true,
      max_seats: 1,
      max_session_members: 8,
      max_concurrent_sessions: 0,
      max_parallel_agents: 4,
      history_days: 0,
      hosted_minutes_month: 0,
      queue_items_month: null,
      audit_log_days: 0,
      webhooks_max: 0,
      api_keys_max: 1,
    },
  },
  pro: {
    name: 'Pro',
    prices: monthly('workspace', 1900, 1900),
    limits: {
      relay_access: true,
      lan_multiplayer: true,
      max_seats: 1,
      max_session_members: 4,
      max_concurrent_sessions: 2,
      max_parallel_agents: 8,
      history_days: 7,
      hosted_minutes_month: 6000,
      queue_items_month: null,
      audit_log_days: 0,
      webhooks_max: 2,
      api_keys_max: 5,
    },
  },
  team: {
    name: 'Team',
    prices: monthly('seat', 2900, 2900),
    limits: {
      relay_access: true,
      lan_multiplayer: true,
      max_seats: 5,
      max_session_members: 12,
      max_concurrent_sessions: 10,
      max_parallel_agents: 16,
      history_days: 30,
      hosted_minutes_month: 30000,
      queue_items_month: null,
      audit_log_days: 90,
      webhooks_max: 20,
      api_keys_max: 50,
    },
  },
});

/** `config` as a seed: every plan once, every limit key once, prices in USD and EUR; else throws. */
export function validateSeedPlans(config: unknown): SeedPlans {
  if (!isRecord(config)) throw new SeedPlansError('the plan seed must be an object');
  for (const key of Object.keys(config)) {
    if (!isPlanId(key)) throw new SeedPlansError(`the plan seed has an unknown plan "${key}"`);
  }
  const seed: Partial<Record<PlanId, SeedPlan>> = {};
  for (const id of PLAN_IDS) {
    const plan = config[id];
    if (!isRecord(plan)) throw new SeedPlansError(`the plan seed has no plan "${id}"`);
    seed[id] = {
      name: checkName(id, plan['name']),
      prices: checkPrices(id, plan['prices']),
      limits: checkSeedLimits(id, plan['limits']),
    };
  }
  return deepFreeze(seed as Record<PlanId, SeedPlan>);
}

function checkName(id: PlanId, name: unknown): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 40) {
    throw new SeedPlansError(`plan ${id}: the name must be 1 to 40 characters`);
  }
  return name;
}

function checkSeedLimits(id: PlanId, limits: unknown): EntitlementLimits {
  if (!isRecord(limits)) throw new SeedPlansError(`plan ${id}: limits must be an object`);
  for (const key of Object.keys(limits)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new SeedPlansError(`plan ${id}: "${key}" is not a CT-ENTITLEMENTS limit key`);
    }
  }
  try {
    checkLimits(id, limits);
  } catch (err) {
    if (err instanceof EntitlementError) throw new SeedPlansError(err.message, { cause: err });
    throw err;
  }
  return Object.fromEntries(LIMIT_KEYS.map((key) => [key, limits[key]])) as EntitlementLimits;
}

function checkPrices(id: PlanId, prices: unknown): SeedPrice[] {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new SeedPlansError(`plan ${id}: prices must be a non-empty list`);
  }
  const seen = new Set<string>();
  const out: SeedPrice[] = [];
  for (const entry of prices as unknown[]) {
    const price = isRecord(entry) ? entry['price'] : undefined;
    const interval = isRecord(entry) ? entry['interval'] : undefined;
    const unit = isRecord(entry) ? entry['unit'] : undefined;
    if (
      !isRecord(price) ||
      !INTERVALS.includes(interval as SeedPrice['interval']) ||
      !UNITS.includes(unit as NonNullable<SeedPrice['unit']>)
    ) {
      throw new SeedPlansError(`plan ${id}: a price needs an interval, a unit and a price`);
    }
    const { amount, currency } = price;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      throw new SeedPlansError(`plan ${id}: an amount is a whole number of minor units, 0 or more`);
    }
    if (!CURRENCIES.includes(currency as Api.Money['currency'])) {
      throw new SeedPlansError(`plan ${id}: prices are in USD or EUR`);
    }
    const key = `${String(interval)}/${String(unit)}/${String(currency)}`;
    if (seen.has(key)) throw new SeedPlansError(`plan ${id}: two prices for ${key}`);
    seen.add(key);
    out.push({
      interval: interval as SeedPrice['interval'],
      unit: unit as NonNullable<SeedPrice['unit']>,
      price: { amount, currency: currency as Api.Money['currency'] },
    });
  }
  for (const key of seen) {
    const [interval, unit] = key.split('/');
    for (const currency of CURRENCIES) {
      if (!seen.has(`${String(interval)}/${String(unit)}/${currency}`)) {
        throw new SeedPlansError(
          `plan ${id}: ${String(interval)}/${String(unit)} has no ${currency} price`,
        );
      }
    }
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
