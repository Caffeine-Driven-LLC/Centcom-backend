/**
 * CT-ENTITLEMENTS fixtures (B069): every valid fixture in contracts/fixtures/entitlements/ comes
 * back out of the service unchanged (its plan's limits in the catalog, its state and rev in the
 * repository), and every invalid one is refused by the schema and by the resolver or the seed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  EntitlementError,
  GRACE_MS,
  resolvedDigest,
  resolveEntitlements,
  SEED_PLANS,
  SeedPlansError,
  validateSeedPlans,
  type EntitlementLimits,
  type Entitlements,
  type PlanId,
} from '../../src/modules/entitlements/index.js';
import { catalogOf, serviceHarness } from './helpers.js';

const DIR = resolve(import.meta.dirname, '../../../../contracts/fixtures/entitlements');

interface Fixture {
  schema: string;
  valid: boolean;
  note: string;
  data: Entitlements & { limits: EntitlementLimits };
}

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(resolve(DIR, file), 'utf8')) as Fixture) }));

describe('the fixtures', () => {
  it('are all here', () => {
    expect(fixtures.map((f) => f.file)).toEqual([
      'bad_plan.json',
      'free.json',
      'lan_false.json',
      'missing_limit.json',
      'past_due.json',
      'pro.json',
      'team.json',
    ]);
  });

  it.each(fixtures)('$file validates as the fixture says', ({ data, valid }) => {
    expect(validate('entitlements', data).ok).toBe(valid);
  });
});

describe.each(fixtures.filter((f) => f.valid))('$file round-trips', ({ data }) => {
  it('through the service', async () => {
    const plan = data.plan as PlanId;
    const h = serviceHarness({
      usage: {
        read: () => Promise.resolve({ usage: data.usage ?? {}, warnings: data.warnings ?? [] }),
      },
    });
    // The fixture's limits are its plan's in the catalog.
    h.repository.catalog = catalogOf().map((p) =>
      p.id === plan ? { ...p, limits: { ...data.limits } } : p,
    );
    h.live.add(data.workspace);
    const period =
      data.period === undefined
        ? null
        : {
            start: new Date(data.period.start),
            end: new Date(data.period.end),
          };
    const graceUntil = data.grace_until == null ? null : new Date(data.grace_until);
    h.clock.now = Date.parse('2026-10-08T12:00:00.000Z');
    const resolved = resolveEntitlements(
      {
        plan,
        status: data.status,
        period,
        grace_until: graceUntil,
        addonSeats: 0,
        now: new Date(h.clock.now),
      },
      new Map(h.repository.catalog.map((p) => [p.id, p.limits as EntitlementLimits])),
    );
    h.repository.rows.set(data.workspace, {
      workspaceId: data.workspace,
      plan,
      status: data.status,
      period,
      graceUntil,
      addonSeats: 0,
      rev: data.rev,
      digest: resolvedDigest(resolved),
      stored: true,
    });
    const got = await h.service.get(data.workspace);
    expect(got).toEqual({
      ...data,
      usage: data.usage ?? {},
      warnings: data.warnings ?? [],
      grace_until: data.grace_until ?? null,
    });
    expect(validate('entitlements', got).ok).toBe(true);
    expect(validate('api/Entitlements', got).ok).toBe(true);
    expect(JSON.parse(JSON.stringify(got))).toEqual(got);
    expect(h.events.published).toEqual([]);
  });
});

describe('the past_due fixture', () => {
  it('is in grace: 7 days after the payment failed', () => {
    const data = fixtures.find((f) => f.file === 'past_due.json')?.data;
    expect(Date.parse(String(data?.grace_until)) - GRACE_MS).toBe(
      Date.parse('2026-10-05T00:00:00.000Z'),
    );
  });
});

describe('the invalid fixtures are refused here too', () => {
  const find = (file: string): Fixture['data'] => {
    const f = fixtures.find((x) => x.file === file);
    if (f === undefined) throw new Error(`no ${file}`);
    return f.data;
  };
  const resolveWith = (plan: string, limits: unknown): unknown =>
    resolveEntitlements(
      { plan, status: 'active', period: null, grace_until: null, addonSeats: 0, now: new Date() },
      new Map([[plan as PlanId, limits as EntitlementLimits]]),
    );
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      if (err instanceof EntitlementError) return err.code;
      throw err;
    }
    return 'accepted';
  };

  it('bad_plan: an unknown plan', () => {
    const data = find('bad_plan.json');
    expect(code(() => resolveWith(data.plan, data.limits))).toBe('unknown_plan');
    expect(() => validateSeedPlans({ ...SEED_PLANS, [data.plan]: SEED_PLANS.free })).toThrow(
      SeedPlansError,
    );
  });

  it('lan_false: LAN off', () => {
    const data = find('lan_false.json');
    expect(code(() => resolveWith('free', data.limits))).toBe('catalog');
    expect(() =>
      validateSeedPlans({ ...SEED_PLANS, free: { ...SEED_PLANS.free, limits: data.limits } }),
    ).toThrow(SeedPlansError);
  });

  it('missing_limit: a limit missing', () => {
    const data = find('missing_limit.json');
    expect(code(() => resolveWith('free', data.limits))).toBe('catalog');
    expect(() =>
      validateSeedPlans({ ...SEED_PLANS, free: { ...SEED_PLANS.free, limits: data.limits } }),
    ).toThrow(SeedPlansError);
  });
});
