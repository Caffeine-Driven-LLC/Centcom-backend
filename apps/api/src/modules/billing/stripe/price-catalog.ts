/**
 * The price catalogue (B070): which Stripe price sells which contract plan, per interval and
 * currency, and the seat add-on (team only). Read from `STRIPE_PRICE_<PLAN|SEAT>_<MONTH|YEAR>_<USD|EUR>`.
 *
 * - Every value must be a Stripe price id (`price_…`), and no id may sell two things.
 * - In production (`NODE_ENV=production`) every combination is required: a missing one is a
 *   ConfigError at startup naming the key. Elsewhere a missing one is simply not for sale.
 * - `lookup` maps a price id back, so a Stripe subscription's items give its plan, interval,
 *   currency and add-on seats.
 *
 * Owns: the catalogue. Must not: hold amounts (Stripe and B069's plans do), or a secret.
 */
import { ConfigError, defineConfig, NODE_ENVS, z, type Env } from '@centcom/core';

/** The plans Stripe sells. */
export const PAID_PLANS = Object.freeze(['pro', 'team'] as const);
export type PaidPlan = (typeof PAID_PLANS)[number];
/** Billing intervals. */
export const INTERVALS = Object.freeze(['month', 'year'] as const);
export type Interval = (typeof INTERVALS)[number];
/** Currencies on sale (CT-API-BILLING: USD, EUR). */
export const CURRENCIES = Object.freeze(['USD', 'EUR'] as const);
export type Currency = (typeof CURRENCIES)[number];

/** Seats a plan includes before add-on seats (CT-ENTITLEMENTS §3; B073 sells the rest). */
export const INCLUDED_SEATS: Readonly<Record<PaidPlan, number>> = Object.freeze({
  pro: 1,
  team: 5,
});
/** The plans that sell add-on seats. */
export const ADDON_SEAT_PLANS: ReadonlySet<PaidPlan> = new Set(['team']);

/** What a price sells. */
export type PriceEntry =
  | { kind: 'plan'; plan: PaidPlan; interval: Interval; currency: Currency }
  | { kind: 'seat'; interval: Interval; currency: Currency };

/** The catalogue. */
export interface PriceCatalog {
  /** The price of `plan`, or null when it is not configured. */
  price(plan: PaidPlan, interval: Interval, currency: Currency): string | null;
  /** The add-on seat price, or null when it is not configured. */
  seatPrice(interval: Interval, currency: Currency): string | null;
  /** What `priceId` sells, or null when the catalogue does not know it. */
  lookup(priceId: string): PriceEntry | null;
}

const PRICE_ID = /^price_[A-Za-z0-9]{1,200}$/;

/** The environment key of a price. */
export const priceKey = (kind: PaidPlan | 'seat', interval: Interval, currency: Currency): string =>
  `STRIPE_PRICE_${kind.toUpperCase()}_${interval.toUpperCase()}_${currency}`;

/** Every catalogue entry with its key. */
function entries(): { key: string; entry: PriceEntry }[] {
  const out: { key: string; entry: PriceEntry }[] = [];
  for (const interval of INTERVALS) {
    for (const currency of CURRENCIES) {
      for (const plan of PAID_PLANS) {
        out.push({
          key: priceKey(plan, interval, currency),
          entry: { kind: 'plan', plan, interval, currency },
        });
      }
      out.push({
        key: priceKey('seat', interval, currency),
        entry: { kind: 'seat', interval, currency },
      });
    }
  }
  return out;
}

/** The environment keys of the catalogue. */
export const priceEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development').meta({
    description: 'development, test or production; production requires every price.',
  }),
  ...Object.fromEntries(
    entries().map(({ key, entry }) => [
      key,
      z
        .string()
        .regex(PRICE_ID, 'must be a Stripe price id (price_…)')
        .optional()
        .meta({
          description:
            entry.kind === 'plan'
              ? `Stripe price of the ${entry.plan} plan, billed every ${entry.interval}, in ${entry.currency}.`
              : `Stripe price of one add-on seat, billed every ${entry.interval}, in ${entry.currency}.`,
        }),
    ]),
  ),
});

/** Reads the catalogue from `env`; a ConfigError naming each bad or (in production) missing key. */
export function loadPriceCatalog(env?: Env): PriceCatalog {
  const values = defineConfig(priceEnvSchema, env) as Record<string, string | undefined>;
  const production = values['NODE_ENV'] === 'production';
  const issues: { key: string; problem: string }[] = [];
  const byKey = new Map<string, string>();
  const byPrice = new Map<string, PriceEntry>();
  for (const { key, entry } of entries()) {
    const id = values[key];
    if (id === undefined) {
      if (production) issues.push({ key, problem: 'is required in production' });
      continue;
    }
    if (byPrice.has(id)) {
      issues.push({ key, problem: 'names a price that another STRIPE_PRICE_* key already sells' });
      continue;
    }
    byKey.set(key, id);
    byPrice.set(id, entry);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return {
    price: (plan, interval, currency) => byKey.get(priceKey(plan, interval, currency)) ?? null,
    seatPrice: (interval, currency) => byKey.get(priceKey('seat', interval, currency)) ?? null,
    lookup: (priceId) => byPrice.get(priceId) ?? null,
  };
}
