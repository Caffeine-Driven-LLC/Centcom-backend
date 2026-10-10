/**
 * The runner (B090; acceptance 2 "Running the whole job twice in a row yields zero deletions on
 * the second run (idempotent) and no errors; killing the process mid-run and restarting completes
 * the remaining work"; acceptance 5 "Dry-run mode logs counts and deletes nothing ... the report
 * row has dry_run=true"; acceptance 6 "A run that would delete more than 20 % of a table aborts
 * with aborted_reason='fraction_exceeded', pages via metric retention_aborted_total, and deletes
 * nothing from that policy"):
 *
 * - each policy writes one `retention_runs` row (dry run or not) with its counts; a second run
 *   deletes nothing; a run left unfinished by a dead worker is closed as `interrupted` and the
 *   next run finishes the work;
 * - the brake's abort is recorded and counted, nothing deleted, the other policies still run (a
 *   dry run that would abort is reported, not counted); a failing policy is recorded `failed` and
 *   does not stop the others; a policy whose lock another run holds is skipped, and runs once a
 *   dead worker's lock has expired;
 * - the budget is shared: what is left goes to each policy; a policy stopped by it reports
 *   `budget_exceeded` and its backlog (the gauge's reading);
 * - metrics: purged per policy, run duration per policy; unknown policy and bad settings refused.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  createPolicyLock,
  createRowPolicy,
  observeRetentionBacklog,
  RetentionAbort,
  RETENTION_LOCK_TTL_MS,
  retentionLockKey,
  RetentionRunner,
  type RetentionContext,
  type RetentionPolicy,
  type RetentionRunConfig,
  type RowRetentionStore,
} from '../../src/index.js';
import { captureLogger, countingMetrics, memoryRuns } from './helpers.js';

/** A table of `total` rows, the first `due` due; `crashAfter` purges, the next one throws. */
function table(total: number, due: number, crashAfter = Infinity) {
  const state = { total, due, purges: 0 };
  const store: RowRetentionStore = {
    count: () => Promise.resolve({ due: state.due, total: state.total }),
    purge(_now, limit) {
      if (state.purges >= crashAfter) return Promise.reject(new Error('worker killed'));
      state.purges += 1;
      const n = Math.min(limit, state.due);
      state.due -= n;
      state.total -= n;
      return Promise.resolve(n);
    },
  };
  return { state, store };
}

const LIVE: RetentionRunConfig = { dryRun: false, force: false, maxDeleteFraction: 0.2 };

function runnerWith(policies: RetentionPolicy[], config: RetentionRunConfig = LIVE) {
  const redis = createMemoryRedis();
  const runs = memoryRuns();
  const counted = countingMetrics();
  const captured = captureLogger();
  const runner = new RetentionRunner({
    policies,
    lock: createPolicyLock(redis.kv),
    runs: runs.store,
    config,
    logger: captured.logger,
    metrics: counted.metrics,
  });
  return { redis, runs, counted, captured, runner };
}

describe('RetentionRunner', () => {
  it('records each policy, and deletes nothing on a second run (acceptance 2)', async () => {
    const tokens = table(10_000, 1_500);
    const inbox = table(10_000, 0);
    const r = runnerWith([
      createRowPolicy({ id: 'login_tokens', owner: 'B014', store: tokens.store, guard: false }),
      createRowPolicy({ id: 'notifications', owner: 'B063', store: inbox.store }),
    ]);
    expect(await r.runner.run()).toEqual([
      {
        policy: 'login_tokens',
        outcome: 'done',
        scanned: 1_500,
        purged: 1_500,
        skipped: 0,
        backlog: 0,
      },
      { policy: 'notifications', outcome: 'done', scanned: 0, purged: 0, skipped: 0, backlog: 0 },
    ]);
    expect(await r.runner.run()).toEqual([
      { policy: 'login_tokens', outcome: 'done', scanned: 0, purged: 0, skipped: 0, backlog: 0 },
      { policy: 'notifications', outcome: 'done', scanned: 0, purged: 0, skipped: 0, backlog: 0 },
    ]);
    expect(
      r.runs.rows.map((row) => [row.policy, row.purged, row.dryRun, row.abortedReason]),
    ).toEqual([
      ['login_tokens', 1_500, false, null],
      ['notifications', 0, false, null],
      ['login_tokens', 0, false, null],
      ['notifications', 0, false, null],
    ]);
    expect(r.runs.rows.every((row) => row.finishedAt !== null)).toBe(true);
    expect(r.counted.count('retention_purged_total', { policy: 'login_tokens' })).toBe(1_500);
    expect(
      r.counted.observed
        .filter((o) => o.name === 'retention_run_duration_seconds')
        .map((o) => o.labels),
    ).toEqual([
      { policy: 'login_tokens' },
      { policy: 'notifications' },
      { policy: 'login_tokens' },
      { policy: 'notifications' },
    ]);
    // The locks are given back.
    expect(await r.redis.kv.get(retentionLockKey('login_tokens'))).toBeNull();
  });

  it('finishes the work of a run that died, closing its report as interrupted (acceptance 2)', async () => {
    const tokens = table(100_000, 3_500, 2); // the third batch "kills the worker"
    const policy = createRowPolicy({
      id: 'login_tokens',
      owner: 'B014',
      store: tokens.store,
      guard: false,
    });
    const r = runnerWith([policy]);
    // A worker that died mid-run leaves its report unfinished.
    await r.runs.store.start('login_tokens', false, new Date(0));
    expect((await r.runner.run())[0]).toMatchObject({ outcome: 'failed' });
    expect(tokens.state.due).toBe(1_500);
    tokens.state.purges = -Infinity; // the restarted worker is healthy
    expect((await r.runner.run())[0]).toMatchObject({ outcome: 'done', purged: 1_500 });
    expect(tokens.state.due).toBe(0);
    expect(r.runs.rows.map((row) => row.abortedReason)).toEqual(['interrupted', 'failed', null]);
    expect(r.counted.count('retention_policy_failures_total', { policy: 'login_tokens' })).toBe(1);
  });

  it('counts only in a dry run, and writes dry_run reports (acceptance 5)', async () => {
    const t = table(1_000, 50);
    const r = runnerWith(
      [createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store })],
      { ...LIVE, dryRun: true },
    );
    expect(await r.runner.run()).toEqual([
      { policy: 'notifications', outcome: 'done', scanned: 50, purged: 0, skipped: 0, backlog: 0 },
    ]);
    expect(t.state.due).toBe(50);
    expect(r.runs.rows[0]).toMatchObject({ dryRun: true, scanned: 50, purged: 0 });
    expect(r.captured.lines().find((l) => l['msg'] === 'retention.policy_ran')).toMatchObject({
      policy: 'notifications',
      scanned: 50,
      purged: 0,
      dry_run: true,
    });
    // A dry run checks the brake too, and reports what the real run would do, with its counts.
    const big = table(100, 50);
    const brake = runnerWith(
      [createRowPolicy({ id: 'notifications', owner: 'B063', store: big.store })],
      { ...LIVE, dryRun: true },
    );
    expect((await brake.runner.run())[0]).toMatchObject({
      outcome: 'fraction_exceeded',
      scanned: 50,
      purged: 0,
    });
    expect(brake.runs.rows[0]).toMatchObject({
      dryRun: true,
      abortedReason: 'fraction_exceeded',
      scanned: 50,
    });
    expect(big.state.due).toBe(50);
    expect(
      brake.counted.count('retention_aborted_total', {
        policy: 'notifications',
        reason: 'fraction_exceeded',
      }),
    ).toBe(0);
  });

  it('records and counts the brake, deletes nothing there, and runs the others (acceptance 6)', async () => {
    const big = table(1_000, 300);
    const small = table(1_000, 10);
    const r = runnerWith([
      createRowPolicy({ id: 'webhook_log', owner: 'B081', store: big.store }),
      createRowPolicy({ id: 'notifications', owner: 'B063', store: small.store }),
    ]);
    const reports = await r.runner.run();
    expect(reports.map((p) => `${p.policy}:${p.outcome}:${p.purged}`)).toEqual([
      'webhook_log:fraction_exceeded:0',
      'notifications:done:10',
    ]);
    expect(big.state.due).toBe(300);
    expect(r.runs.rows[0]).toMatchObject({
      abortedReason: 'fraction_exceeded',
      scanned: 300,
      purged: 0,
    });
    expect(
      r.counted.count('retention_aborted_total', {
        policy: 'webhook_log',
        reason: 'fraction_exceeded',
      }),
    ).toBe(1);
    expect(r.captured.lines().find((l) => l['msg'] === 'retention.policy_aborted')).toMatchObject({
      level: 'error',
      policy: 'webhook_log',
    });
    // RETENTION_FORCE lets it through.
    const forced = runnerWith(
      [createRowPolicy({ id: 'webhook_log', owner: 'B081', store: big.store })],
      { ...LIVE, force: true },
    );
    expect((await forced.runner.run())[0]).toMatchObject({ outcome: 'done', purged: 300 });
  });

  it('skips a policy whose lock another run holds', async () => {
    const t = table(100, 10);
    const r = runnerWith([createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store })]);
    await r.redis.kv.setIfAbsent(retentionLockKey('notifications'), 'other', 60_000);
    expect((await r.runner.run())[0]).toMatchObject({ outcome: 'locked', purged: 0 });
    expect(t.state.due).toBe(10);
    expect(r.runs.rows).toEqual([]);
    expect(await r.redis.kv.get(retentionLockKey('notifications'))).toBe('other');
  });

  it('runs once a dead worker’s lock has expired, closing its report as interrupted', async () => {
    let now = 0;
    const redis = createMemoryRedis(() => now);
    const runs = memoryRuns();
    const t = table(100, 10);
    const runner = new RetentionRunner({
      policies: [createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store })],
      lock: createPolicyLock(redis.kv),
      runs: runs.store,
      config: LIVE,
      clock: () => now,
    });
    // What a killed worker leaves: its lock and an unfinished report.
    await redis.kv.setIfAbsent(retentionLockKey('notifications'), 'dead', RETENTION_LOCK_TTL_MS);
    await runs.store.start('notifications', false, new Date(0));
    expect((await runner.run())[0]).toMatchObject({ outcome: 'locked' });
    now += RETENTION_LOCK_TTL_MS + 1;
    expect((await runner.run())[0]).toMatchObject({ outcome: 'done', purged: 10 });
    expect(runs.rows.map((row) => row.abortedReason)).toEqual(['interrupted', null]);
  });

  it('shares the budget, and reports a stopped policy and its backlog', async () => {
    const seen: number[] = [];
    let now = 0;
    const slow: RetentionPolicy = {
      id: 'slow',
      owner: 'B090',
      run(ctx: RetentionContext) {
        seen.push(ctx.budgetMs);
        now += 20 * 60 * 1000;
        return Promise.resolve({ scanned: 5, purged: 5, skipped: 0 });
      },
    };
    const stopped: RetentionPolicy = {
      id: 'stopped',
      owner: 'B090',
      run(ctx: RetentionContext) {
        seen.push(ctx.budgetMs);
        return Promise.resolve({
          scanned: 9,
          purged: 2,
          skipped: 0,
          backlog: 7,
          stopped: 'budget_exceeded' as const,
        });
      },
    };
    const redis = createMemoryRedis();
    const runs = memoryRuns();
    const runner = new RetentionRunner({
      policies: [slow, stopped],
      lock: createPolicyLock(redis.kv),
      runs: runs.store,
      config: LIVE,
      clock: () => now,
    });
    const reports = await runner.run();
    expect(seen).toEqual([30 * 60 * 1000, 10 * 60 * 1000]);
    expect(reports[1]).toEqual({
      policy: 'stopped',
      outcome: 'budget_exceeded',
      scanned: 9,
      purged: 2,
      skipped: 0,
      backlog: 7,
    });
    expect(runs.rows[1]?.abortedReason).toBe('budget_exceeded');
    const gauges: { name: string; read: () => unknown }[] = [];
    observeRetentionBacklog({ gauge: (name, read) => gauges.push({ name, read }) }, runner);
    expect(gauges[0]?.name).toBe('retention_backlog');
    expect(gauges[0]?.read()).toEqual([
      { value: 0, labels: { policy: 'slow' } },
      { value: 7, labels: { policy: 'stopped' } },
    ]);
  });

  it('runs one policy on request, and refuses unknown ones and bad settings', async () => {
    const a = table(100, 1);
    const b = table(100, 1);
    const r = runnerWith([
      createRowPolicy({ id: 'notifications', owner: 'B063', store: a.store }),
      createRowPolicy({ id: 'invites', owner: 'B029', store: b.store }),
    ]);
    expect((await r.runner.run({ policy: 'invites' })).map((p) => p.policy)).toEqual(['invites']);
    expect(a.state.due).toBe(1);
    await expect(r.runner.run({ policy: 'nope' })).rejects.toThrow(TypeError);
    const policy = createRowPolicy({ id: 'invites', owner: 'B029', store: b.store });
    const lock = createPolicyLock(createMemoryRedis().kv);
    const runs = memoryRuns().store;
    expect(
      () => new RetentionRunner({ policies: [policy, policy], lock, runs, config: LIVE }),
    ).toThrow(TypeError);
    expect(
      () =>
        new RetentionRunner({
          policies: [policy],
          lock,
          runs,
          config: { ...LIVE, maxDeleteFraction: 0 },
        }),
    ).toThrow(RangeError);
    expect(r.runner.policyIds).toEqual(['notifications', 'invites']);
  });

  it('lets RetentionAbort through only as the brake', () => {
    expect(new RetentionAbort('fraction_exceeded')).toMatchObject({
      reason: 'fraction_exceeded',
      scanned: 0,
    });
  });
});
