/**
 * The entitlement service (B069) over the in-memory repository: the default row, `rev` moving
 * only on a real change and in the change's transaction, the invalidation after the commit (with
 * its retry), changes time makes, refused states, usage, the catalog cache and the seed check, and
 * a property over random sequences of changes.
 */
import { validate } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_TTL_MS,
  ENTITLEMENT_STATUSES,
  ENTITLEMENTS_INVALIDATE_CHANNEL,
  EntitlementError,
  EntitlementService,
  GRACE_MS,
  PLAN_IDS,
  SEED_PLANS,
  SeedPlansError,
  type SubscriptionState,
  type UsageReaderPort,
} from '../../src/modules/entitlements/index.js';
import { serviceHarness } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const period = (startMs: number, days = 30): SubscriptionState['period'] => ({
  start: new Date(startMs),
  end: new Date(startMs + days * DAY),
});
const pro = (now: number, over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  plan: 'pro',
  status: 'active',
  period: period(now - DAY),
  past_due_since: null,
  addon_seats: 0,
  ...over,
});

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EntitlementError);
  expect((err as EntitlementError).code).toBe(code);
};

describe('reading', () => {
  it('a new workspace is free with status none at rev 0, and gets its row', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const got = await h.service.get(id);
    expect(got).toEqual({
      workspace: id,
      rev: 0,
      plan: 'free',
      status: 'none',
      limits: SEED_PLANS.free.limits,
      usage: {},
      warnings: [],
      grace_until: null,
    });
    expect(validate('entitlements', got).ok).toBe(true);
    expect(validate('api/Entitlements', got).ok).toBe(true);
    expect(h.repository.rows.get(id)).toMatchObject({ plan: 'free', status: 'none', rev: 0 });
    await h.service.get(id);
    expect(h.repository.writes).toBe(0);
    expect(h.events.published).toEqual([]);
  });

  it('is null for a workspace that does not exist or was deleted', async () => {
    const h = serviceHarness();
    expect(await h.service.get('wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).toBeNull();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    h.live.delete(id);
    expect(await h.service.get(id)).toBeNull();
  });

  it('carries the period and validates against both schemas', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const state = pro(h.clock.now);
    await h.service.applySubscriptionState(id, state);
    const got = await h.service.get(id);
    expect(got).toMatchObject({
      plan: 'pro',
      status: 'active',
      rev: 1,
      period: { start: state.period?.start.toISOString(), end: state.period?.end.toISOString() },
      limits: SEED_PLANS.pro.limits,
    });
    expect(validate('entitlements', got).ok).toBe(true);
    expect(validate('api/Entitlements', got).ok).toBe(true);
  });
});

describe('applySubscriptionState', () => {
  it('twice with the same state: rev unchanged, no second invalidation', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const state = pro(h.clock.now);
    expect(await h.service.applySubscriptionState(id, state)).toEqual({ rev: 1, changed: true });
    expect(await h.service.applySubscriptionState(id, state)).toEqual({ rev: 1, changed: false });
    expect(h.events.published).toEqual([
      {
        channel: ENTITLEMENTS_INVALIDATE_CHANNEL,
        message: JSON.stringify({ workspace: id, rev: 1 }),
      },
    ]);
  });

  it('a plan change moves rev on by exactly 1 and publishes {workspace, rev}', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    const team = pro(h.clock.now, { plan: 'team' });
    expect(await h.service.applySubscriptionState(id, team)).toEqual({ rev: 2, changed: true });
    expect(h.events.payloads()).toEqual([
      { workspace: id, rev: 1 },
      { workspace: id, rev: 2 },
    ]);
    expect(h.recorded.count('entitlements_rev_changes_total', { cause: 'state' })).toBe(2);
  });

  it('a renewal (a new period) is written without moving rev', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    const renewed = pro(h.clock.now, { period: period(h.clock.now + 29 * DAY) });
    expect(await h.service.applySubscriptionState(id, renewed)).toEqual({ rev: 1, changed: false });
    expect((await h.service.get(id))?.period?.start).toBe(renewed.period?.start.toISOString());
    expect(h.events.published).toHaveLength(1);
  });

  it('add-on seats move rev, as they change max_seats', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now, { plan: 'team' }));
    expect(
      await h.service.applySubscriptionState(
        id,
        pro(h.clock.now, { plan: 'team', addon_seats: 3 }),
      ),
    ).toEqual({ rev: 2, changed: true });
    expect((await h.service.get(id))?.limits.max_seats).toBe(8);
  });

  it('going to none from the default is no change', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const none = {
      ...pro(h.clock.now),
      plan: 'free' as const,
      status: 'none' as const,
      period: null,
    };
    expect(await h.service.applySubscriptionState(id, none)).toEqual({ rev: 0, changed: false });
    expect(h.events.published).toEqual([]);
  });

  it('two concurrent applies of one change move rev once', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const state = pro(h.clock.now);
    const results = await Promise.all([
      h.service.applySubscriptionState(id, state),
      h.service.applySubscriptionState(id, state),
    ]);
    expect(results.map((r) => r.rev)).toEqual([1, 1]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(h.events.published).toHaveLength(1);
  });

  it('404 for a workspace that does not exist or was deleted', async () => {
    const h = serviceHarness();
    const err = await h.service
      .applySubscriptionState('wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W', pro(h.clock.now))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(404);
  });

  describe('refused states write nothing and are counted', () => {
    it.each([
      ['unknown_plan', { plan: 'enterprise' }],
      ['unknown_status', { status: 'paused' }],
      ['addon_seats', { plan: 'team', addon_seats: -1 }],
      ['addon_seats', { plan: 'team', addon_seats: 1.5 }],
      ['period', { period: { start: new Date(2), end: new Date(1) } }],
      ['grace', { status: 'past_due', past_due_since: null }],
    ] as const)('%s', async (code, over) => {
      const h = serviceHarness();
      const id = h.workspace();
      await h.service.applySubscriptionState(id, pro(h.clock.now));
      const before = h.repository.rows.get(id);
      await rejectsWith(
        h.service.applySubscriptionState(id, {
          ...pro(h.clock.now),
          ...(over as unknown as Partial<SubscriptionState>),
        }),
        code,
      );
      expect(h.repository.rows.get(id)).toBe(before);
      expect(h.events.published).toHaveLength(1);
      expect(h.recorded.count('entitlements_state_rejected_total', { code })).toBe(1);
      const line = h.captured.lines().find((l) => l['msg'] === 'entitlements.state_rejected');
      expect(line).toMatchObject({ workspace_id: id, reason: code });
    });
  });
});

describe('time', () => {
  it('past_due: grace 7 days after past_due_since, then none with rev moved on', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    const since = new Date(h.clock.now);
    expect(
      await h.service.applySubscriptionState(
        id,
        pro(h.clock.now, { status: 'past_due', past_due_since: since }),
      ),
    ).toEqual({ rev: 2, changed: true });
    h.clock.advance(GRACE_MS);
    expect(await h.service.get(id)).toMatchObject({
      rev: 2,
      plan: 'pro',
      status: 'past_due',
      grace_until: new Date(since.getTime() + GRACE_MS).toISOString(),
      limits: SEED_PLANS.pro.limits,
    });
    h.clock.advance(1000);
    const lapsed = await h.service.get(id);
    expect(lapsed).toMatchObject({ rev: 3, plan: 'free', status: 'none', grace_until: null });
    expect(lapsed?.limits).toEqual(SEED_PLANS.free.limits);
    expect(lapsed).not.toHaveProperty('period');
    expect(h.events.payloads().at(-1)).toEqual({ workspace: id, rev: 3 });
    expect(h.recorded.count('entitlements_rev_changes_total', { cause: 'read' })).toBe(1);
    // Read again: no further change.
    expect((await h.service.get(id))?.rev).toBe(3);
    expect(h.events.published).toHaveLength(3);
    // Billing then records the lapse: the result is what clients already have at rev 3.
    const none = { ...pro(h.clock.now), plan: 'pro' as const, status: 'none' as const };
    expect(await h.service.applySubscriptionState(id, none)).toEqual({ rev: 3, changed: false });
  });

  it('canceled: the plan until period.end, none one millisecond after', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const state = pro(h.clock.now, { plan: 'team', status: 'canceled' });
    await h.service.applySubscriptionState(id, state);
    const end = state.period?.end.getTime() ?? 0;
    h.clock.now = end;
    expect(await h.service.get(id)).toMatchObject({ rev: 1, plan: 'team', status: 'canceled' });
    h.clock.now = end + 1;
    expect(await h.service.get(id)).toMatchObject({ rev: 2, plan: 'free', status: 'none' });
  });

  it('a change of the plan limits moves rev on at the next read', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    const proPlan = h.repository.catalog.find((p) => p.id === 'pro');
    if (proPlan === undefined) throw new Error('no pro plan');
    proPlan.limits.history_days = 14;
    expect((await h.service.get(id))?.rev).toBe(1);
    h.clock.advance(CATALOG_TTL_MS);
    expect(await h.service.get(id)).toMatchObject({ rev: 2, limits: { history_days: 14 } });
  });
});

describe('invalidation', () => {
  it('is retried once', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    h.events.failNext = 1;
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    expect(h.events.attempts).toBe(2);
    expect(h.events.payloads()).toEqual([{ workspace: id, rev: 1 }]);
    expect(h.recorded.count('entitlements_invalidate_failures_total')).toBe(0);
  });

  it('failing twice is counted and logged; the change stays committed', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    h.events.failNext = 2;
    expect(await h.service.applySubscriptionState(id, pro(h.clock.now))).toEqual({
      rev: 1,
      changed: true,
    });
    expect(h.events.published).toEqual([]);
    expect(h.recorded.count('entitlements_invalidate_failures_total')).toBe(1);
    expect(
      h.captured.lines().find((l) => l['msg'] === 'entitlements.invalidate_failed'),
    ).toMatchObject({
      workspace_id: id,
      rev: 1,
    });
    expect(await h.service.get(id)).toMatchObject({ rev: 1, plan: 'pro' });
  });

  it('comes after the commit: a transaction that fails publishes nothing', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const original = h.repository.transaction.bind(h.repository);
    h.repository.transaction = (fn) =>
      original(async (tx) => {
        await fn(tx);
        throw new Error('commit failed');
      });
    await expect(h.service.applySubscriptionState(id, pro(h.clock.now))).rejects.toThrow(
      'commit failed',
    );
    expect(h.events.attempts).toBe(0);
    expect(h.repository.rows.get(id)).toBeUndefined();
  });
});

describe('bumpRev', () => {
  it('moves rev on by 1 and announces it, state unchanged', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.applySubscriptionState(id, pro(h.clock.now));
    expect(await h.service.bumpRev(id, 'usage_warning')).toBe(2);
    expect(await h.service.get(id)).toMatchObject({ rev: 2, plan: 'pro', status: 'active' });
    expect(h.events.payloads().at(-1)).toEqual({ workspace: id, rev: 2 });
    expect(h.recorded.count('entitlements_rev_changes_total', { cause: 'usage_warning' })).toBe(1);
  });

  it('refuses an unknown reason and a missing workspace', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await expect(h.service.bumpRev(id, 'whim' as 'admin')).rejects.toThrow(TypeError);
    const err = await h.service
      .bumpRev('wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'admin')
      .catch((e: unknown) => e);
    expect((err as AppError).status).toBe(404);
  });
});

describe('usage', () => {
  it("comes from the UsageReaderPort, for the row's period", async () => {
    const seen: unknown[] = [];
    const usage: UsageReaderPort = {
      read: (workspaceId, p) => {
        seen.push([workspaceId, p]);
        return Promise.resolve({
          usage: { hosted_minutes_month: 4900 },
          warnings: [{ limit: 'hosted_minutes_month', pct: 80 }],
        });
      },
    };
    const h = serviceHarness({ usage });
    const id = h.workspace();
    const state = pro(h.clock.now);
    await h.service.applySubscriptionState(id, state);
    const got = await h.service.get(id);
    expect(got).toMatchObject({
      usage: { hosted_minutes_month: 4900 },
      warnings: [{ limit: 'hosted_minutes_month', pct: 80 }],
    });
    expect(seen).toEqual([[id, state.period]]);
    expect(validate('entitlements', got).ok).toBe(true);
  });

  it('a failing reader gives none, counted', async () => {
    const h = serviceHarness({ usage: { read: () => Promise.reject(new Error('down')) } });
    const id = h.workspace();
    expect(await h.service.get(id)).toMatchObject({ usage: {}, warnings: [] });
    expect(h.recorded.count('entitlements_usage_failures_total')).toBe(1);
  });
});

describe('the catalog', () => {
  it('is cached for the TTL, and a failed load is not kept', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    await h.service.get(id);
    await h.service.plans();
    expect(h.repository.planReads).toBe(1);
    h.clock.advance(CATALOG_TTL_MS);
    h.repository.failPlans = true;
    await expect(h.service.get(id)).rejects.toThrow('db down');
    h.repository.failPlans = false;
    await h.service.get(id);
    expect(h.repository.planReads).toBe(3);
  });

  it('with a limit missing fails the read', async () => {
    const h = serviceHarness();
    const id = h.workspace();
    const free = h.repository.catalog.find((p) => p.id === 'free');
    delete free?.limits.api_keys_max;
    await rejectsWith(h.service.get(id), 'catalog');
  });
});

describe('the seed', () => {
  it('is checked when the service starts', () => {
    const h = serviceHarness();
    const bad = { ...SEED_PLANS, enterprise: SEED_PLANS.team };
    expect(
      () => new EntitlementService({ repository: h.repository, events: h.events, seed: bad }),
    ).toThrow(SeedPlansError);
  });
});

describe('property: rev', () => {
  it('never goes back, moves by at most 1 per call, and each move is announced in order', async () => {
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('apply' as const),
        plan: fc.constantFrom(...PLAN_IDS),
        status: fc.constantFrom(...ENTITLEMENT_STATUSES),
        seats: fc.integer({ min: 0, max: 3 }),
        days: fc.integer({ min: 1, max: 40 }),
      }),
      fc.record({ kind: fc.constant('read' as const) }),
      fc.record({ kind: fc.constant('bump' as const) }),
      fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 10 * DAY }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        const h = serviceHarness();
        const id = h.workspace();
        let rev = 0;
        for (const o of ops) {
          if (o.kind === 'wait') {
            h.clock.advance(o.ms);
            continue;
          }
          let next = rev;
          if (o.kind === 'read') next = (await h.service.get(id))?.rev ?? -1;
          if (o.kind === 'bump') next = await h.service.bumpRev(id, 'admin');
          if (o.kind === 'apply') {
            const now = h.clock.now;
            const result = await h.service.applySubscriptionState(id, {
              plan: o.plan,
              status: o.status,
              period: period(now - DAY, o.days),
              past_due_since: o.status === 'past_due' ? new Date(now - o.days * DAY) : null,
              addon_seats: o.seats,
            });
            next = result.rev;
            expect(result.changed).toBe(next === rev + 1);
          }
          expect(next === rev || next === rev + 1).toBe(true);
          rev = next;
        }
        const revs = h.events.payloads().map((p) => p.rev);
        expect(revs).toEqual(Array.from({ length: rev }, (_, i) => i + 1));
      }),
      { numRuns: 200 },
    );
  });
});
