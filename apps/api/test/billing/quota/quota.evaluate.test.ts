/**
 * Evaluating quotas (B076 acceptance 1 to 5, with the in-process store; the same on Postgres in
 * `quota.postgres.test.ts`):
 *
 * 1. 79.9 % to 80.0 % of `hosted_minutes_month`: exactly one `usage_warning {pct: 80, resets_at}`
 *    notice and one owner notification, also when `evaluateQuota` runs 10 times at once;
 * 2. 100 %: exactly one `quota_reached {resets_at}` notice, the `quota:state` field `reached`;
 *    `resets_at` is the entitlements' `period.end`, RFC 3339 UTC with milliseconds;
 * 3. 50 % to 130 % in one update: the warning and then the reached level, each once;
 * 4. a null limit never signals; a 0 limit never warns (any use is `reached`);
 * 5. a new period, or a limit raised so usage is below 80 %, returns the state to `ok` and a later
 *    crossing signals again; within one period and level nothing repeats.
 *
 * Also: transitions as the card's `QuotaTransition`; a workspace that is not hosted, or has no
 * entitlements, is not evaluated; a limit that signalled and lost its counter is not re-armed.
 *
 * Re-arming only for the card's reasons (a new period, a raised or removed limit):
 * - two overlapping evaluations, the first reading 4 799 and the second 4 800: the usage is read
 *   after the workspace's lock, so the older reading never undoes the newer claim, and a third
 *   evaluation sends nothing (the regression of reading before the lock);
 * - a lower reading under the same limit changes nothing;
 * - a removed limit re-arms, and a later crossing under a restored one signals again;
 * - a raised limit re-arms only the levels claimed under a lower limit; the levels below a
 *   re-armed one are claimed in the same decision (a 0 limit's `reached`, raised to 90 % of a new
 *   limit, claims `warn`), so the rows, the hash and `warnings[]` agree.
 */
import { describe, expect, it } from 'vitest';
import { NOW, PERIOD, sent, signalsWith } from './helpers.js';

/** A tick of the event loop for the other evaluation to run up to where it waits. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const RESETS_AT = '2026-11-01T00:00:00.000Z';

describe('evaluateQuota', () => {
  it('warns once at 80.0 %, even when 10 evaluations run at once (acceptance 1)', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4794); // 79.9 % of 6 000
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx)).toEqual({ notices: [], notifications: [], webhooks: [] });

    ctx.counters.set(ctx.ws, 4800); // 80.0 %
    const runs = await Promise.all(
      Array.from({ length: 10 }, () => ctx.signals.evaluateQuota(ctx.ws, NOW)),
    );
    expect(runs.flat()).toEqual([
      { limit: 'hosted_minutes_month', from: 'ok', to: 'warn', pct: 80 },
    ]);
    expect(ctx.store.of(ctx.ws)).toEqual(['hosted_minutes_month/warn']);
    expect(ctx.notices.published).toEqual([
      {
        channel: `relay:notice:${ctx.ws}`,
        notice: { code: 'usage_warning', level: 'warn', params: { pct: 80, resets_at: RESETS_AT } },
      },
    ]);
    expect(ctx.notify.events).toEqual([
      expect.objectContaining({
        category: 'usage_warning',
        recipients: { workspace: ctx.ws, roles: ['owner'] },
        params: { limit: 'hosted_minutes_month', pct: 80 },
      }),
    ]);
    expect(sent(ctx).webhooks).toEqual(['hosted_minutes_month:80']);
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'warn',
      queue_items_month: 'ok',
    });
  });

  it('signals quota_reached once at 100 %, with resets_at the period end (acceptance 2)', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 5999);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.counters.set(ctx.ws, 6000);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'hosted_minutes_month', from: 'warn', to: 'reached', pct: 100 },
    ]);
    ctx.counters.set(ctx.ws, 6500);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
    const reached = ctx.notices.published[1]?.notice;
    expect(reached).toEqual({
      code: 'quota_reached',
      level: 'error',
      params: { resets_at: RESETS_AT },
    });
    expect(reached?.params.resets_at).toBe(PERIOD.end);
    expect(reached?.params.resets_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    expect(ctx.state.entries.get(`quota:state:${ctx.ws}`)?.expiresAt).toBe(
      Date.parse(PERIOD.end) + 60 * 60 * 1000,
    );
    expect(sent(ctx).notifications).toEqual([
      'usage_warning:hosted_minutes_month',
      'quota_reached:hosted_minutes_month',
    ]);
  });

  it('fires the warning and then reached, each once, on a jump from 50 % to 130 % (acceptance 3)', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 3000, 500);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.counters.set(ctx.ws, 7800, 500);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'hosted_minutes_month', from: 'ok', to: 'reached', pct: 130 },
    ]);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning', 'quota_reached'],
      notifications: ['usage_warning:hosted_minutes_month', 'quota_reached:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80', 'hosted_minutes_month:100'],
    });
    expect(ctx.store.of(ctx.ws)).toEqual([
      'hosted_minutes_month/reached',
      'hosted_minutes_month/warn',
    ]);
  });

  it('never signals a null limit, and never warns on a 0 limit (acceptance 4)', async () => {
    const ctx = signalsWith();
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: null, queue_items_month: 0 });
    ctx.counters.set(ctx.ws, 1_000_000, 0);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx).notices).toEqual([]);
    ctx.counters.set(ctx.ws, 1_000_000, 1);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'queue_items_month', from: 'ok', to: 'reached', pct: 100 },
    ]);
    expect(sent(ctx)).toEqual({
      notices: ['quota_reached'],
      notifications: ['quota_reached:queue_items_month'],
      webhooks: ['queue_items_month:100'],
    });
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'ok',
      queue_items_month: 'reached',
    });
  });

  it('re-arms on a new period and on a raised limit, and never repeats within one (acceptance 5)', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);

    // The limit is raised to 10 000: 60 %, back to ok; both levels re-arm.
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 10_000 });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'hosted_minutes_month', from: 'reached', to: 'ok', pct: 60 },
    ]);
    expect(ctx.store.of(ctx.ws)).toEqual([]);
    expect((await ctx.signals.getQuotaState(ctx.ws)).hosted_minutes_month).toBe('ok');
    ctx.counters.set(ctx.ws, 8000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached', 'usage_warning']);

    // Raised again to 9 000 (88 %): still warn, nothing re-armed or repeated.
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 9000 });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);

    // November: a new period; the counter starts again.
    const november = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
    const later = new Date('2026-11-02T00:00:00.000Z');
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 9000 }, november);
    ctx.counters.set(ctx.ws, 100);
    expect(await ctx.signals.evaluateQuota(ctx.ws, later)).toEqual([]);
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'ok',
      queue_items_month: 'ok',
    });
    ctx.counters.set(ctx.ws, 7300);
    expect(await ctx.signals.evaluateQuota(ctx.ws, later)).toEqual([
      { limit: 'hosted_minutes_month', from: 'ok', to: 'warn', pct: 81 },
    ]);
    expect(ctx.notices.published.at(-1)?.notice).toEqual({
      code: 'usage_warning',
      level: 'warn',
      params: { pct: 80, resets_at: november.end },
    });
    expect(ctx.store.of(ctx.ws)).toEqual([
      'hosted_minutes_month/warn',
      'hosted_minutes_month/warn',
    ]);
  });

  it('uses the calendar month for a workspace without a period', async () => {
    const ctx = signalsWith();
    ctx.entitlements.set(ctx.ws, {}, null);
    ctx.counters.set(ctx.ws, 4800);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(ctx.notices.published[0]?.notice.params.resets_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('skips workspaces that are not hosted or have no entitlements, and limits that lost their counter', async () => {
    const ctx = signalsWith();
    ctx.entitlements.set(ctx.ws, { relay_access: false });
    ctx.counters.set(ctx.ws, 6000);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(await ctx.signals.getQuotaState(ctx.ws)).toEqual({
      hosted_minutes_month: 'ok',
      queue_items_month: 'ok',
    });
    expect(ctx.recorded.count('quota_evaluations_skipped_total', { reason: 'not_hosted' })).toBe(1);

    expect(await ctx.signals.evaluateQuota('wsp_01J0000000000000000000GONE', NOW)).toEqual([]);
    expect(
      ctx.recorded.count('quota_evaluations_skipped_total', { reason: 'no_entitlements' }),
    ).toBe(1);

    ctx.entitlements.set(ctx.ws, { relay_access: true });
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(ctx.store.of(ctx.ws)).toEqual([
      'hosted_minutes_month/reached',
      'hosted_minutes_month/warn',
    ]);
    ctx.counters.totals.delete(ctx.ws);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(ctx.store.of(ctx.ws)).toEqual([
      'hosted_minutes_month/reached',
      'hosted_minutes_month/warn',
    ]);
    expect(
      ctx.captured
        .lines()
        .find((l) => l['msg'] === 'quota.evaluation_skipped' && l['reason'] === 'usage_missing'),
    ).toMatchObject({ workspace_id: ctx.ws, limit: 'hosted_minutes_month' });
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
  });

  it('runs once more when the entitlements change during the evaluation', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    // The second read (inside the decision) sees a raised limit: the evaluation starts again.
    ctx.entitlements.onRead((ws, read) => {
      if (read === 2) ctx.entitlements.set(ws, { hosted_minutes_month: 10_000 });
    });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(ctx.store.of(ctx.ws)).toEqual([]);
    expect(ctx.recorded.count('quota_evaluations_rerun_total')).toBe(1);
    expect(sent(ctx).notices).toEqual([]);
  });

  it('never lets an older reading undo a newer claim when two evaluations overlap', async () => {
    const ctx = signalsWith();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    ctx.counters.port.totals = async () => {
      reads += 1;
      if (reads === 1) {
        await held; // the first reading is the older one, and it is slow to arrive
        return { 'relay.hosted_minutes': 4799 };
      }
      return { 'relay.hosted_minutes': 4800 };
    };
    const first = ctx.signals.evaluateQuota(ctx.ws, NOW);
    await tick();
    const second = ctx.signals.evaluateQuota(ctx.ws, NOW);
    await tick();
    release();
    expect([...(await first), ...(await second)]).toEqual([
      { limit: 'hosted_minutes_month', from: 'ok', to: 'warn', pct: 80 },
    ]);
    expect(ctx.store.of(ctx.ws)).toEqual(['hosted_minutes_month/warn']);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx)).toEqual({
      notices: ['usage_warning'],
      notifications: ['usage_warning:hosted_minutes_month'],
      webhooks: ['hosted_minutes_month:80'],
    });
    expect((await ctx.signals.getQuotaState(ctx.ws)).hosted_minutes_month).toBe('warn');
  });

  it('changes nothing on a lower reading under the same limit', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 6000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.counters.set(ctx.ws, 4000); // 66 %: an older or corrected reading, never a fall
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(ctx.store.of(ctx.ws)).toEqual([
      'hosted_minutes_month/reached',
      'hosted_minutes_month/warn',
    ]);
    expect(await ctx.state.cache.read(ctx.ws)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    ctx.counters.set(ctx.ws, 6000);
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([]);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'quota_reached']);
    expect(
      ctx.recorded.count('quota_signals_rearmed_total', { limit: 'hosted_minutes_month' }),
    ).toBe(0);
  });

  it('re-arms a removed limit, and signals again once it is back', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: null });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'hosted_minutes_month', from: 'warn', to: 'ok', pct: 0 },
    ]);
    expect(ctx.store.of(ctx.ws)).toEqual([]);
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 6000 });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'hosted_minutes_month', from: 'ok', to: 'warn', pct: 80 },
    ]);
    expect(sent(ctx).notices).toEqual(['usage_warning', 'usage_warning']);
  });

  it('re-arms only levels claimed under a lower limit, and claims the levels below them', async () => {
    const ctx = signalsWith();
    ctx.entitlements.set(ctx.ws, { queue_items_month: 0 });
    ctx.counters.set(ctx.ws, 0, 90);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(ctx.store.limitsOf(ctx.ws)).toEqual(['queue_items_month/reached=0']);

    // Raised to 100: 90 % is warn, which never fired for the 0 limit; it fires now.
    ctx.entitlements.set(ctx.ws, { queue_items_month: 100 });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'queue_items_month', from: 'reached', to: 'warn', pct: 90 },
    ]);
    expect(ctx.store.limitsOf(ctx.ws)).toEqual(['queue_items_month/warn=100']);
    expect(await ctx.signals.getWarnings(ctx.ws)).toEqual([
      { limit: 'queue_items_month', pct: 80 },
    ]);
    await ctx.state.cache.drop(ctx.ws);
    expect((await ctx.signals.getQuotaState(ctx.ws)).queue_items_month).toBe('warn');
    expect(sent(ctx).notices).toEqual(['quota_reached', 'usage_warning']);

    // Lowered to 80 (reached), then raised back to 100: only the reached claimed under 80 re-arms.
    ctx.entitlements.set(ctx.ws, { queue_items_month: 80 });
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(ctx.store.limitsOf(ctx.ws)).toEqual([
      'queue_items_month/reached=80',
      'queue_items_month/warn=100',
    ]);
    ctx.entitlements.set(ctx.ws, { queue_items_month: 100 });
    expect(await ctx.signals.evaluateQuota(ctx.ws, NOW)).toEqual([
      { limit: 'queue_items_month', from: 'reached', to: 'warn', pct: 90 },
    ]);
    expect(ctx.store.limitsOf(ctx.ws)).toEqual(['queue_items_month/warn=100']);
    expect(sent(ctx).notices).toEqual(['quota_reached', 'usage_warning', 'quota_reached']);
  });
});
