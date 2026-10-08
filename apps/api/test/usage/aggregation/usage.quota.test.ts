/**
 * Quota state (B075 acceptance 2 and 3, card test usage.quota.test.ts): with a limit of 6 000
 * (pro's `hosted_minutes_month`), 4 799 used is pct 79 and no warning, 4 800 is pct 80 and exactly
 * one warning, 6 000 is pct 100 and exceeded; a null limit is pct null, never exceeded; a limit of
 * 0 is pct 0 at 0 used and exceeded on any use. The hosted-minutes meter is the relay's: client
 * `agent_minutes` (informational, CT-ENTITLEMENTS §5) never moves it. `check` lets an action through
 * until the limit and then gives the seconds to the period's end. A property test over random
 * event streams: used is their sum, pct is floor(used × 100 / limit), warnings follow pct.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { quotaItem, warningOf } from '../../../src/modules/usage/quota.js';
import { usageHarness } from './helpers.js';

describe('quotaItem', () => {
  it.each([
    [4799, 79, false, null],
    [4800, 80, false, 80],
    [5999, 99, false, 80],
    [6000, 100, true, 100],
    [9000, 150, true, 100],
  ] as const)('a limit of 6 000 with %i used is pct %i', (used, pct, exceeded, warning) => {
    const item = quotaItem('hosted_minutes_month', used, 6000);
    expect(item).toEqual({ key: 'hosted_minutes_month', used, limit: 6000, pct, exceeded });
    expect(warningOf(item)?.pct ?? null).toBe(warning);
  });

  it('treats null as unlimited and 0 as nothing allowed', () => {
    expect(quotaItem('queue_items_month', 1_000_000, null)).toMatchObject({
      pct: null,
      exceeded: false,
    });
    expect(warningOf(quotaItem('queue_items_month', 1_000_000, null))).toBeNull();
    expect(quotaItem('hosted_minutes_month', 0, 0)).toMatchObject({ pct: 0, exceeded: false });
    expect(quotaItem('hosted_minutes_month', 1, 0)).toMatchObject({ pct: 100, exceeded: true });
  });
});

describe('QuotaService', () => {
  it('meters hosted minutes from the relay, never from client agent_minutes', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    await h.subscribe(ws, 'pro', month);
    h.ingest(
      ws,
      'agent_minutes',
      99_999,
      new Date(h.clock.now - 60_000),
      new Date(h.clock.now - 120_000),
    );
    await h.aggregator.run();
    let state = await h.quota.compute(ws);
    expect(state.items.find((i) => i.key === 'hosted_minutes_month')).toMatchObject({
      used: 0,
      limit: 6000,
      pct: 0,
    });
    expect(state.warnings).toEqual([]);
    h.relay.record(ws, 'hosted_minutes', 4799);
    await h.aggregator.run();
    state = await h.quota.compute(ws);
    expect(state.items.find((i) => i.key === 'hosted_minutes_month')).toMatchObject({
      used: 4799,
      pct: 79,
    });
    expect(state.warnings).toEqual([]);
    h.relay.record(ws, 'hosted_minutes', 1);
    await h.aggregator.run();
    state = await h.quota.compute(ws);
    expect(state.warnings).toEqual([{ limit: 'hosted_minutes_month', pct: 80 }]);
    expect(state.period).toEqual(month);
  });

  it('lets an action through until the limit, then gives the seconds to the period end', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    await h.subscribe(ws, 'pro', month);
    h.relay.record(ws, 'hosted_minutes', 5999);
    await h.aggregator.run();
    expect(await h.quota.check(ws, 'hosted_minutes_month')).toEqual({
      allowed: true,
      retryAfterS: null,
    });
    h.relay.record(ws, 'hosted_minutes', 1);
    await h.aggregator.run();
    expect(await h.quota.check(ws, 'hosted_minutes_month')).toEqual({
      allowed: false,
      retryAfterS: Math.ceil((month.end.getTime() - h.clock.now) / 1000),
    });
    // The free plan allows no hosted minutes: any use is over.
    const free = h.workspace();
    expect(await h.quota.check(free, 'hosted_minutes_month')).toEqual({
      allowed: true,
      retryAfterS: null,
    });
    h.relay.record(free, 'hosted_minutes', 1);
    await h.aggregator.run();
    expect((await h.quota.check(free, 'hosted_minutes_month')).allowed).toBe(false);
  });

  it('agrees with the sum of any event stream (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 40 }),
        async (amounts) => {
          const h = usageHarness();
          const ws = h.workspace();
          await h.subscribe(ws, 'pro', calendarMonth(new Date(h.clock.now)));
          for (const a of amounts) h.relay.record(ws, 'hosted_minutes', a);
          await h.aggregator.run();
          const state = await h.quota.compute(ws);
          const item = state.items.find((i) => i.key === 'hosted_minutes_month');
          const used = amounts.reduce((n, a) => n + a, 0);
          const pct = Math.floor((used * 100) / 6000);
          const warning = pct >= 100 ? 100 : pct >= 80 ? 80 : null;
          return (
            item?.used === used &&
            item.pct === pct &&
            item.exceeded === used >= 6000 &&
            (state.warnings.find((w) => w.limit === 'hosted_minutes_month')?.pct ?? null) ===
              warning
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
