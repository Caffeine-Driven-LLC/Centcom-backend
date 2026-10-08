/**
 * The plan seed (B069): it equals CT-ENTITLEMENTS §3's reference table (read from the contract),
 * the migration seeds the same rows, and `validateSeedPlans` refuses an unknown plan or limit key,
 * a missing plan or limit, and malformed prices.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIMIT_KEYS,
  PLAN_IDS,
  SEED_PLANS,
  SeedPlansError,
  validateSeedPlans,
  type PlanId,
} from '../../src/modules/entitlements/index.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CONTRACT = readFileSync(resolve(ROOT, 'contracts/07-billing-entitlements.md'), 'utf8');
const MIGRATION = readFileSync(
  resolve(ROOT, 'packages/db/migrations/20260102001500_plans_entitlements.sql'),
  'utf8',
);

/** §3's table: key -> plan -> value (`5 (+ add-on seats)` is 5, `6 000 (100 h)` is 6000). */
function contractTable(): Map<string, Record<PlanId, boolean | number>> {
  const section = CONTRACT.split('## 3. Default plans')[1]?.split('\n## ')[0] ?? '';
  const table = new Map<string, Record<PlanId, boolean | number>>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const key = /^`(\w+)`$/.exec(cells[1] ?? '')?.[1];
    if (key === undefined) continue;
    const value = (cell: string | undefined): boolean | number => {
      const bare = (cell ?? '').replace(/\(.*\)/, '').replace(/\s/g, '');
      if (bare === 'true' || bare === 'false') return bare === 'true';
      if (!/^\d+$/.test(bare)) throw new Error(`cannot read "${String(cell)}" for ${key}`);
      return Number(bare);
    };
    table.set(key, { free: value(cells[2]), pro: value(cells[3]), team: value(cells[4]) });
  }
  return table;
}

describe('the seed', () => {
  it("equals the contract's reference table, key by key", () => {
    const table = contractTable();
    expect(table.size).toBe(10);
    for (const [key, values] of table) {
      expect(LIMIT_KEYS).toContain(key);
      for (const plan of PLAN_IDS) {
        expect([
          plan,
          key,
          SEED_PLANS[plan].limits[key as keyof typeof SEED_PLANS.free.limits],
        ]).toEqual([plan, key, values[plan]]);
      }
    }
  });

  it('has LAN on everywhere and queue items unlimited, as §2 and the fixtures say', () => {
    for (const plan of PLAN_IDS) {
      expect(SEED_PLANS[plan].limits.lan_multiplayer).toBe(true);
      expect(SEED_PLANS[plan].limits.queue_items_month).toBeNull();
    }
  });

  it('has every limit key for every plan, and nothing else', () => {
    for (const plan of PLAN_IDS) {
      expect(Object.keys(SEED_PLANS[plan].limits).sort()).toEqual([...LIMIT_KEYS].sort());
    }
  });

  it('is what the migration seeds', () => {
    const rows = [
      ...MIGRATION.matchAll(/\('(free|pro|team)', '(\w+)', (true|false|null), (\d+|null)\)/g),
    ];
    expect(rows).toHaveLength(PLAN_IDS.length * LIMIT_KEYS.length);
    const seeded: Record<string, Record<string, unknown>> = { free: {}, pro: {}, team: {} };
    for (const [, plan, key, bool, int] of rows) {
      const value = bool === 'null' ? (int === 'null' ? null : Number(int)) : bool === 'true';
      (seeded[plan as string] as Record<string, unknown>)[key as string] = value;
    }
    for (const plan of PLAN_IDS) expect(seeded[plan]).toEqual(SEED_PLANS[plan].limits);
    const names = [...MIGRATION.matchAll(/\('(free|pro|team)', '(\w+)'\)/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(names).toEqual(PLAN_IDS.map((id) => [id, SEED_PLANS[id].name]));
  });

  it('prices every plan in USD and EUR integer minor units', () => {
    for (const plan of PLAN_IDS) {
      const currencies = SEED_PLANS[plan].prices.map((p) => p.price.currency).sort();
      expect(currencies).toEqual(['EUR', 'USD']);
      for (const { price } of SEED_PLANS[plan].prices) {
        expect(Number.isSafeInteger(price.amount)).toBe(true);
      }
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SEED_PLANS)).toBe(true);
    expect(Object.isFrozen(SEED_PLANS.team.limits)).toBe(true);
    expect(Object.isFrozen(SEED_PLANS.team.prices[0]?.price)).toBe(true);
  });
});

describe('validateSeedPlans', () => {
  const clone = (): Record<string, Record<string, unknown>> =>
    JSON.parse(JSON.stringify(SEED_PLANS)) as Record<string, Record<string, unknown>>;
  const limits = (
    seed: Record<string, Record<string, unknown>>,
    plan: string,
  ): Record<string, unknown> => seed[plan]?.['limits'] as Record<string, unknown>;
  const prices = (
    seed: Record<string, Record<string, unknown>>,
    plan: string,
  ): Record<string, unknown>[] => seed[plan]?.['prices'] as Record<string, unknown>[];

  it('accepts the reference seed', () => {
    expect(validateSeedPlans(clone())).toEqual(SEED_PLANS);
  });

  const refusals: [string, (seed: Record<string, Record<string, unknown>>) => unknown][] = [
    ['an unknown plan key', (s) => ({ ...s, enterprise: s['team'] })],
    ['a missing plan', (s) => ({ free: s['free'], pro: s['pro'] })],
    ['a limit missing for a plan', (s) => (delete limits(s, 'pro')['history_days'], s)],
    ['an unknown limit key', (s) => ((limits(s, 'team')['max_projects'] = 5), s)],
    [
      'null for a count that cannot be unlimited',
      (s) => ((limits(s, 'team')['webhooks_max'] = null), s),
    ],
    ['a negative count', (s) => ((limits(s, 'free')['api_keys_max'] = -1), s)],
    ['LAN off', (s) => ((limits(s, 'free')['lan_multiplayer'] = false), s)],
    ['an empty name', (s) => (((s['pro'] as Record<string, unknown>)['name'] = ''), s)],
    ['no prices', (s) => (((s['pro'] as Record<string, unknown>)['prices'] = []), s)],
    [
      'a float amount',
      (s) => (((prices(s, 'pro')[0]?.['price'] as Record<string, unknown>)['amount'] = 19.99), s),
    ],
    [
      'a negative amount',
      (s) => (((prices(s, 'pro')[0]?.['price'] as Record<string, unknown>)['amount'] = -1), s),
    ],
    [
      'a currency other than USD or EUR',
      (s) => (((prices(s, 'pro')[1]?.['price'] as Record<string, unknown>)['currency'] = 'GBP'), s),
    ],
    [
      'a USD price without its EUR one',
      (s) => (((s['pro'] as Record<string, unknown>)['prices'] = [prices(s, 'pro')[0]]), s),
    ],
    [
      'the same price twice',
      (s) => (
        ((s['pro'] as Record<string, unknown>)['prices'] = [
          ...prices(s, 'pro'),
          prices(s, 'pro')[0],
        ]),
        s
      ),
    ],
    [
      'an unknown interval',
      (s) => (((prices(s, 'team')[0] as Record<string, unknown>)['interval'] = 'week'), s),
    ],
    [
      'an unknown unit',
      (s) => (((prices(s, 'team')[0] as Record<string, unknown>)['unit'] = 'agent'), s),
    ],
    ['a seed that is not an object', () => []],
    ['a plan that is not an object', (s) => ({ ...s, pro: 'Pro' })],
  ];
  it.each(refusals)('refuses %s', (_name, mutate) => {
    expect(() => validateSeedPlans(mutate(clone()))).toThrow(SeedPlansError);
  });
});
