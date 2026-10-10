/**
 * The quota state flag and warnings (B076 acceptance 8 "getQuotaState returns reached within 1 s
 * of the transition so B080 can use it"; scope "Maintain Redis hash quota:state:{wsp} ... TTL
 * until period end + 1 h ... expose warnings[] data for the entitlements object"; guardrail "MUST
 * treat Redis as a cache: SQL quota_signal_state is authoritative and quota:state is rebuildable";
 * interface `getQuotaState` "reads Redis first, falls back to SQL"):
 *
 * - right after the evaluation that reached 100 %, `getQuotaState` answers `reached` (from the
 *   hash, written before the decision commits), well within 1 s;
 * - with the hash gone, expired or unreadable it answers from the stored signals and rebuilds the
 *   hash, but only if it is still missing: a decision that wrote it after the SQL read keeps its
 *   level; a rebuild that fails is logged; unlimited limits and workspaces that are not hosted are
 *   `ok`;
 * - a hash that could not be written is dropped (readers go to SQL) and the evaluation throws for
 *   its job to retry, after delivering;
 * - `getWarnings` and `quotaWarningsReader` (B069's `warnings[]`): pct 80 or 100 per limit, gone
 *   once a raised limit re-armed it, the usage numbers B075 reports left as they were.
 */
import { describe, expect, it } from 'vitest';
import { QuotaStateCacheError } from '../../../src/modules/billing/quota/service.js';
import { quotaWarningsReader } from '../../../src/modules/billing/quota/triggers.js';
import { NOW, PERIOD, sent, signalsWith } from './helpers.js';

describe('getQuotaState', () => {
  it('answers reached within 1 s of the transition', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    const started = performance.now();
    const state = await ctx.signals.getQuotaState(ctx.ws);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(state).toEqual({ hosted_minutes_month: 'reached', queue_items_month: 'ok' });
  });

  it('answers from the stored signals when the hash is gone or unreadable, and rebuilds it', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800, 1000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    await ctx.state.cache.drop(ctx.ws);
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'warn',
      queue_items_month: 'reached',
    });
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'warn',
      queue_items_month: 'reached',
    });

    ctx.state.cache.read = () => Promise.reject(new Error('READONLY'));
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'warn',
      queue_items_month: 'reached',
    });
    expect(ctx.captured.lines().some((l) => l['msg'] === 'quota.state_cache_unreadable')).toBe(
      true,
    );
  });

  it('never replaces a decision’s hash with an older SQL reading', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    await ctx.state.cache.drop(ctx.ws);
    ctx.counters.set(ctx.ws, 6000);
    // Between the rebuild's SQL read (warn) and its write, an evaluation decides reached.
    const levels = ctx.store.store.levels;
    ctx.store.store.levels = async (workspaceId, periodStart) => {
      const read = await levels(workspaceId, periodStart);
      await ctx.signals.evaluateQuota(ctx.ws, NOW);
      return read;
    };
    expect((await ctx.signals.getQuotaState(ctx.ws)).hosted_minutes_month).toBe('warn');
    ctx.store.store.levels = levels;
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    expect((await ctx.signals.getQuotaState(ctx.ws)).hosted_minutes_month).toBe('reached');
  });

  it('answers from SQL when the rebuild cannot be written, and logs it', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    await ctx.state.cache.drop(ctx.ws);
    ctx.state.cache.fill = () => Promise.reject(new Error('READONLY'));
    expect((await ctx.signals.getQuotaState(ctx.ws)).hosted_minutes_month).toBe('warn');
    expect(ctx.recorded.count('quota_state_cache_failures_total')).toBe(1);
    expect(ctx.captured.lines().some((l) => l['msg'] === 'quota.state_cache_failed')).toBe(true);
  });

  it('answers ok for unlimited limits, workspaces not hosted and unknown workspaces', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000, 1000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    await ctx.state.cache.drop(ctx.ws);
    ctx.entitlements.set(ctx.ws, { queue_items_month: null });
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    await ctx.state.cache.drop(ctx.ws);
    ctx.entitlements.set(ctx.ws, { relay_access: false });
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'ok',
      queue_items_month: 'ok',
    });
    expect(await ctx.signals.getQuotaState('wsp_01J0000000000000000000GONE')).toEqual({
      hosted_minutes_month: 'ok',
      queue_items_month: 'ok',
    });
  });

  it('drops a hash it could not write, delivers, and throws for the job to retry', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000);
    const write = ctx.state.cache.write;
    ctx.state.cache.write = () => Promise.reject(new Error('OOM command not allowed'));
    await expect(ctx.signals.evaluateQuota(ctx.ws, NOW)).rejects.toBeInstanceOf(
      QuotaStateCacheError,
    );
    expect(ctx.state.entries.size).toBe(0);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
    expect(ctx.recorded.count('quota_state_cache_failures_total')).toBe(1);
    ctx.state.cache.write = write;
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
  });
});

describe('warnings', () => {
  it('lists each limit at 80 or 100, and drops a re-armed one', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800, 1000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(await ctx.signals.getWarnings(ctx.ws)).toEqual([
      { limit: 'hosted_minutes_month', pct: 80 },
      { limit: 'queue_items_month', pct: 100 },
    ]);

    const inner = {
      read: () =>
        Promise.resolve({
          usage: { hosted_minutes_month: 4800, queue_items_month: 1000 },
          warnings: [{ limit: 'hosted_minutes_month', pct: 100 }],
        }),
    };
    const reader = quotaWarningsReader(inner, ctx.store.store, () => NOW.getTime());
    const period = { start: new Date(PERIOD.start), end: new Date(PERIOD.end) };
    expect(await reader.read(ctx.ws, period)).toEqual({
      usage: { hosted_minutes_month: 4800, queue_items_month: 1000 },
      warnings: [
        { limit: 'hosted_minutes_month', pct: 80 },
        { limit: 'queue_items_month', pct: 100 },
      ],
    });

    ctx.entitlements.set(ctx.ws, { queue_items_month: 5000 });
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(await ctx.signals.getWarnings(ctx.ws)).toEqual([
      { limit: 'hosted_minutes_month', pct: 80 },
    ]);
    expect((await reader.read(ctx.ws, period)).warnings).toEqual([
      { limit: 'hosted_minutes_month', pct: 80 },
    ]);
  });
});
