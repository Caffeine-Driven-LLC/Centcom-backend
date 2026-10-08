/**
 * The resolver (B069, CT-ENTITLEMENTS §3-§4): every plan under every status, the boundary
 * instants of grace and cancellation, add-on seats, the typed errors, and properties over random
 * states.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_STATUSES,
  EntitlementError,
  GRACE_MS,
  graceUntilFor,
  LIMIT_KEYS,
  MAX_ADDON_SEATS,
  PLAN_IDS,
  resolvedDigest,
  resolveEntitlements,
  SEED_PLANS,
  type EntitlementLimits,
  type PlanCatalog,
  type PlanId,
  type ResolveInput,
} from '../../src/modules/entitlements/index.js';

const catalog: PlanCatalog = new Map(PLAN_IDS.map((id) => [id, SEED_PLANS[id].limits]));
const NOW = new Date('2026-10-08T12:00:00.000Z');
const PERIOD = {
  start: new Date('2026-10-01T00:00:00.000Z'),
  end: new Date('2026-11-01T00:00:00.000Z'),
};

const input = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  plan: 'pro',
  status: 'active',
  period: PERIOD,
  grace_until: null,
  addonSeats: 0,
  now: NOW,
  ...over,
});

/** The contract's columns (CT-ENTITLEMENTS §3, the card's acceptance 1). */
const PRO: EntitlementLimits = {
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
};
const TEAM: EntitlementLimits = {
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
};
const FREE: EntitlementLimits = {
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
};
const COLUMNS: Record<PlanId, EntitlementLimits> = { free: FREE, pro: PRO, team: TEAM };

const error = (fn: () => unknown): EntitlementError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof EntitlementError) return err;
    throw err;
  }
  throw new Error('expected an EntitlementError');
};

describe('the contract columns', () => {
  it.each(PLAN_IDS)('%s/active equals its column, lan_multiplayer true', (plan) => {
    const resolved = resolveEntitlements(input({ plan }), catalog);
    expect(resolved).toEqual({
      plan,
      status: 'active',
      limits: COLUMNS[plan],
      period: PERIOD,
      grace_until: null,
    });
    expect(Object.keys(resolved.limits)).toEqual(LIMIT_KEYS);
  });
});

describe('plan x status', () => {
  const keeps = (plan: PlanId, status: string): ResolveInput =>
    input({
      plan,
      status,
      grace_until: status === 'past_due' ? new Date(NOW.getTime() + 1000) : null,
    });
  for (const plan of PLAN_IDS) {
    for (const status of ENTITLEMENT_STATUSES) {
      it(`${plan}/${status}`, () => {
        const resolved = resolveEntitlements(keeps(plan, status), catalog);
        if (status === 'none') {
          expect(resolved).toEqual({
            plan: 'free',
            status: 'none',
            limits: FREE,
            period: null,
            grace_until: null,
          });
        } else {
          expect(resolved.plan).toBe(plan);
          expect(resolved.status).toBe(status);
          expect(resolved.limits).toEqual(COLUMNS[plan]);
        }
        expect(resolved.limits.lan_multiplayer).toBe(true);
      });
    }
  }

  it('trialing equals the trial plan', () => {
    for (const plan of PLAN_IDS) {
      expect(resolveEntitlements(input({ plan, status: 'trialing' }), catalog).limits).toEqual(
        resolveEntitlements(input({ plan, status: 'active' }), catalog).limits,
      );
    }
  });
});

describe('past_due grace', () => {
  const since = new Date('2026-10-05T09:30:00.000Z');
  const grace = graceUntilFor(since);
  const at = (ms: number): ReturnType<typeof resolveEntitlements> =>
    resolveEntitlements(
      input({ status: 'past_due', grace_until: grace, now: new Date(ms) }),
      catalog,
    );

  it('ends 7 days after the payment failed', () => {
    expect(grace.toISOString()).toBe('2026-10-12T09:30:00.000Z');
    expect(grace.getTime() - since.getTime()).toBe(GRACE_MS);
  });

  it('keeps the plan through grace_until, and reports it', () => {
    expect(at(since.getTime())).toMatchObject({ plan: 'pro', status: 'past_due', limits: PRO });
    expect(at(grace.getTime())).toEqual({
      plan: 'pro',
      status: 'past_due',
      limits: PRO,
      period: PERIOD,
      grace_until: grace,
    });
  });

  it('is none one second after grace_until (and one millisecond)', () => {
    for (const late of [1, 1000]) {
      expect(at(grace.getTime() + late)).toEqual({
        plan: 'free',
        status: 'none',
        limits: FREE,
        period: null,
        grace_until: null,
      });
    }
  });
});

describe('canceled', () => {
  const at = (ms: number, period = PERIOD): ReturnType<typeof resolveEntitlements> =>
    resolveEntitlements(
      input({ plan: 'team', status: 'canceled', period, now: new Date(ms) }),
      catalog,
    );

  it('keeps the plan until period.end, free one millisecond after', () => {
    expect(at(PERIOD.end.getTime())).toMatchObject({
      plan: 'team',
      status: 'canceled',
      limits: TEAM,
    });
    expect(at(PERIOD.end.getTime() + 1)).toMatchObject({
      plan: 'free',
      status: 'none',
      limits: FREE,
    });
  });

  it('without a period is none', () => {
    expect(resolveEntitlements(input({ status: 'canceled', period: null }), catalog)).toMatchObject(
      { plan: 'free', status: 'none', limits: FREE, period: null },
    );
  });
});

describe('add-on seats', () => {
  it('team with 3 add-on seats has 8 seats', () => {
    expect(
      resolveEntitlements(input({ plan: 'team', addonSeats: 3 }), catalog).limits.max_seats,
    ).toBe(8);
  });

  it('do not change the catalog', () => {
    resolveEntitlements(input({ plan: 'team', addonSeats: 3 }), catalog);
    expect(catalog.get('team')?.max_seats).toBe(5);
  });

  it('count on team only, and not once the plan has lapsed', () => {
    expect(resolveEntitlements(input({ addonSeats: 3 }), catalog).limits.max_seats).toBe(1);
    expect(
      resolveEntitlements(input({ plan: 'team', status: 'none', addonSeats: 3 }), catalog).limits
        .max_seats,
    ).toBe(1);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_ADDON_SEATS + 1, '3' as unknown])(
    '%s throws a typed error',
    (seats) => {
      const err = error(() =>
        resolveEntitlements(input({ plan: 'team', addonSeats: seats as number }), catalog),
      );
      expect(err.code).toBe('addon_seats');
    },
  );

  it('are checked whatever the status', () => {
    expect(
      error(() => resolveEntitlements(input({ status: 'none', addonSeats: -2 }), catalog)).code,
    ).toBe('addon_seats');
  });
});

describe('refused inputs', () => {
  it.each([
    ['unknown_plan', input({ plan: 'enterprise' })],
    ['unknown_status', input({ status: 'paused' })],
    ['grace', input({ status: 'past_due', grace_until: null })],
    ['grace', input({ status: 'past_due', grace_until: new Date(Number.NaN) })],
    ['grace', input({ status: 'active', grace_until: NOW })],
    ['period', input({ period: { start: PERIOD.end, end: PERIOD.start } })],
    ['period', input({ period: { start: PERIOD.start, end: PERIOD.start } })],
    ['period', input({ period: { start: new Date(Number.NaN), end: PERIOD.end } })],
    ['time', input({ now: new Date(Number.NaN) })],
  ] as const)('%s', (code, bad) => {
    expect(error(() => resolveEntitlements(bad, catalog)).code).toBe(code);
  });

  it('graceUntilFor refuses a non-time', () => {
    expect(error(() => graceUntilFor(new Date('nope'))).code).toBe('grace');
  });

  it('a catalog without the plan, with a limit missing or invalid, or with LAN off', () => {
    const without = new Map(catalog);
    without.delete('pro');
    expect(error(() => resolveEntitlements(input(), without)).code).toBe('catalog');
    for (const broken of [
      { ...PRO, history_days: undefined },
      { ...PRO, max_session_members: null },
      { ...PRO, api_keys_max: -1 },
      { ...PRO, webhooks_max: 2.5 },
      { ...PRO, relay_access: 'yes' },
      { ...PRO, lan_multiplayer: false },
    ]) {
      const bad = new Map(catalog).set('pro', broken as unknown as EntitlementLimits);
      expect(error(() => resolveEntitlements(input(), bad)).code).toBe('catalog');
    }
  });
});

describe('the digest', () => {
  const digest = (over: Partial<ResolveInput>): string =>
    resolvedDigest(resolveEntitlements(input(over), catalog)).toString('hex');

  it('follows plan, status and limits, not the period or grace', () => {
    expect(digest({})).toBe(
      digest({ period: { start: PERIOD.start, end: new Date('2027-01-01') } }),
    );
    expect(digest({})).not.toBe(digest({ status: 'trialing' }));
    expect(digest({})).not.toBe(digest({ plan: 'team' }));
    expect(digest({ plan: 'team' })).not.toBe(digest({ plan: 'team', addonSeats: 1 }));
    expect(digest({ status: 'past_due', grace_until: new Date(NOW.getTime() + 1) })).toBe(
      digest({ status: 'past_due', grace_until: new Date(NOW.getTime() + 2) }),
    );
  });

  it('changes with any limit', () => {
    const base = resolveEntitlements(input(), catalog);
    const seen = new Set([resolvedDigest(base).toString('hex')]);
    for (const key of LIMIT_KEYS) {
      const value = base.limits[key];
      const changed = {
        ...base.limits,
        [key]: typeof value === 'boolean' ? !value : (value ?? 0) + 1,
      };
      seen.add(resolvedDigest({ ...base, limits: changed }).toString('hex'));
    }
    expect(seen.size).toBe(LIMIT_KEYS.length + 1);
  });
});

describe('properties', () => {
  const state = fc.record({
    plan: fc.constantFrom(...PLAN_IDS),
    status: fc.constantFrom(...ENTITLEMENT_STATUSES),
    start: fc.integer({ min: 0, max: 10 ** 12 }),
    length: fc.integer({ min: 1, max: 10 ** 10 }),
    grace: fc.integer({ min: 0, max: 2 * 10 ** 12 }),
    addonSeats: fc.integer({ min: 0, max: MAX_ADDON_SEATS }),
    withPeriod: fc.boolean(),
  });
  type State = typeof state extends fc.Arbitrary<infer T> ? T : never;
  const toInput = (s: State, now: number): ResolveInput => ({
    plan: s.plan,
    status: s.status,
    period: s.withPeriod ? { start: new Date(s.start), end: new Date(s.start + s.length) } : null,
    grace_until: s.status === 'past_due' ? new Date(s.grace) : null,
    addonSeats: s.addonSeats,
    now: new Date(now),
  });

  it('give the plan or the free defaults, with every key and LAN on', () => {
    fc.assert(
      fc.property(state, fc.integer({ min: 0, max: 3 * 10 ** 12 }), (s, now) => {
        const r = resolveEntitlements(toInput(s, now), catalog);
        expect(Object.keys(r.limits)).toEqual(LIMIT_KEYS);
        expect(r.limits.lan_multiplayer).toBe(true);
        if (r.status === 'none') {
          expect(r).toEqual({
            plan: 'free',
            status: 'none',
            limits: FREE,
            period: null,
            grace_until: null,
          });
        } else {
          expect(r.plan).toBe(s.plan);
          expect(r.status).toBe(s.status);
          const seats = COLUMNS[s.plan].max_seats;
          expect(r.limits).toEqual({
            ...COLUMNS[s.plan],
            max_seats: s.plan === 'team' && seats !== null ? seats + s.addonSeats : seats,
          });
        }
      }),
      { numRuns: 500 },
    );
  });

  it('once lapsed, stay lapsed as time goes on', () => {
    fc.assert(
      fc.property(
        state,
        fc.integer({ min: 0, max: 2 * 10 ** 12 }),
        fc.integer({ min: 0, max: 10 ** 12 }),
        (s, now, later) => {
          const before = resolveEntitlements(toInput(s, now), catalog);
          const after = resolveEntitlements(toInput(s, now + later), catalog);
          if (before.status === 'none') expect(after.status).toBe('none');
          expect(resolveEntitlements(toInput(s, now), catalog)).toEqual(before);
        },
      ),
      { numRuns: 500 },
    );
  });
});
