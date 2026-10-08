/**
 * Crossings (B075 acceptance 2, 3, 4 and 5, guardrail "each crossing at most once per period",
 * failure mode "bumpRev fails"): at 4 800 of 6 000 one QuotaCrossed(80) and one rev bump; at
 * 6 000 one QuotaCrossed(100) and one more bump; further usage emits nothing more this period;
 * GET entitlements then lists the warning with the limit key and pct. A failed bump marks nothing
 * and the crossing is retried (and emitted once) on the next run. A null limit never crosses; a 0
 * limit crosses on any use. Next period, a crossing can recur, and the old period's state is kept.
 */
import { describe, expect, it } from 'vitest';
import { calendarMonth } from '../../../src/modules/usage/period.js';
import { usageHarness } from './helpers.js';

describe('quota crossings', () => {
  it('emits 80 and 100 once each, bumping rev once per crossing, and shows the warning', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const month = calendarMonth(new Date(h.clock.now));
    await h.subscribe(ws, 'pro', month);
    const revAfterSubscribe = (await h.service.get(ws))?.rev ?? 0;

    h.relay.record(ws, 'hosted_minutes', 4799);
    await h.aggregator.run();
    expect(h.emitted).toEqual([]);
    expect(h.bumps).toEqual([]);

    h.relay.record(ws, 'hosted_minutes', 1);
    await h.aggregator.run();
    expect(h.emitted).toEqual([
      { workspace: ws, limit: 'hosted_minutes_month', pct: 80, resets_at: month.end.toISOString() },
    ]);
    expect(h.bumps).toEqual([ws]);
    const ent = await h.service.get(ws);
    expect(ent?.rev).toBe(revAfterSubscribe + 1);
    expect(ent?.warnings).toEqual([{ limit: 'hosted_minutes_month', pct: 80 }]);
    expect(ent?.usage?.hosted_minutes_month).toBe(4800);

    h.relay.record(ws, 'hosted_minutes', 1200);
    await h.aggregator.run();
    expect(h.emitted.map((e) => e.pct)).toEqual([80, 100]);
    expect(h.bumps).toEqual([ws, ws]);
    expect((await h.service.get(ws))?.warnings).toEqual([
      { limit: 'hosted_minutes_month', pct: 100 },
    ]);

    h.relay.record(ws, 'hosted_minutes', 5000);
    await h.aggregator.run();
    await h.quota.detectCrossings(ws);
    expect(h.emitted).toHaveLength(2);
    expect(h.bumps).toHaveLength(2);
  });

  it('marks nothing when the bump fails, and crosses on the next run', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    await h.subscribe(ws, 'pro', calendarMonth(new Date(h.clock.now)));
    h.relay.record(ws, 'hosted_minutes', 4800);
    h.failBumps(true);
    await h.aggregator.run();
    expect(h.emitted).toEqual([]);
    expect(await h.counters.crossings(ws, calendarMonth(new Date(h.clock.now)).start)).toEqual([]);
    h.failBumps(false);
    // No new usage: the failed workspace is checked again all the same.
    await h.aggregator.run();
    expect(h.emitted.map((e) => [e.limit, e.pct])).toEqual([['hosted_minutes_month', 80]]);
    await h.aggregator.run();
    expect(h.emitted).toHaveLength(1);
  });

  it('never crosses a null limit, and crosses a 0 limit on any use', async () => {
    const h = usageHarness();
    const team = h.workspace();
    await h.subscribe(team, 'team', calendarMonth(new Date(h.clock.now)));
    h.relay.record(team, 'queue_items', 1_000_000);
    await h.aggregator.run();
    expect(
      h.emitted.filter((e) => e.workspace === team && e.limit === 'queue_items_month'),
    ).toEqual([]);

    const free = h.workspace();
    h.relay.record(free, 'hosted_minutes', 1);
    await h.aggregator.run();
    expect(h.emitted.filter((e) => e.workspace === free).map((e) => e.pct)).toEqual([80, 100]);
  });

  it('recurs next period and keeps the old period', async () => {
    const h = usageHarness();
    const ws = h.workspace();
    const first = calendarMonth(new Date(h.clock.now));
    await h.subscribe(ws, 'pro', first);
    h.relay.record(ws, 'hosted_minutes', 4800);
    await h.aggregator.run();
    expect(h.emitted).toHaveLength(1);

    // The next period begins at `end` exactly.
    const second = calendarMonth(first.end);
    h.clock.now = first.end.getTime();
    await h.subscribe(ws, 'pro', second);
    let state = await h.quota.compute(ws);
    expect(state.period).toEqual(second);
    expect(state.items.find((i) => i.key === 'hosted_minutes_month')?.used).toBe(0);
    expect(state.warnings).toEqual([]);
    h.relay.record(ws, 'hosted_minutes', 4800);
    await h.aggregator.run();
    expect(h.emitted.map((e) => e.resets_at)).toEqual([
      first.end.toISOString(),
      second.end.toISOString(),
    ]);
    expect(await h.counters.crossings(ws, first.start)).toHaveLength(1);
    expect(h.counters.counter(ws, first.start, 'relay.hosted_minutes')).toBe(4800);
    state = await h.quota.compute(ws);
    expect(state.warnings).toEqual([{ limit: 'hosted_minutes_month', pct: 80 }]);
  });
});
