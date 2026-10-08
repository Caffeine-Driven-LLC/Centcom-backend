/**
 * The `usage.aggregate` job (B075): a run calls the aggregator at the clock's time and logs counts
 * only when something moved; the schedule is one repeating job every 15 s per queue, with 3
 * attempts and backoff; failed runs are kept 7 days.
 */
import { describe, expect, it } from 'vitest';
import {
  processUsageAggregate,
  scheduleUsageAggregate,
  USAGE_AGGREGATE_EVERY_MS,
  USAGE_AGGREGATE_SCHEDULER_ID,
  usageAggregateJobOptions,
} from '../src/jobs/usage-aggregate.js';

describe('usage.aggregate', () => {
  it('runs the aggregator at the clock and logs counts only when something moved', async () => {
    const runs: Date[] = [];
    const lines: string[] = [];
    const logger = {
      debug: (obj: unknown, msg: string) => lines.push(`${msg} ${JSON.stringify(obj)}`),
    };
    const deps = {
      run: (now: Date) => {
        runs.push(now);
        return Promise.resolve(
          runs.length === 1 ? { workspaces: 2, events: 40 } : { workspaces: 0, events: 0 },
        );
      },
      clock: () => Date.UTC(2026, 9, 8, 12, 0, 0),
      logger: logger as never,
    };
    expect(await processUsageAggregate(deps)).toEqual({ workspaces: 2, events: 40 });
    await processUsageAggregate(deps);
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2026-10-08T12:00:00.000Z',
      '2026-10-08T12:00:00.000Z',
    ]);
    expect(lines).toEqual(['usage.aggregated {"workspaces":2,"events":40}']);
  });

  it('schedules one repeating run every 15 seconds', async () => {
    const calls: unknown[][] = [];
    const queue = { upsertJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(args)) };
    await scheduleUsageAggregate(queue as never);
    expect(calls).toEqual([
      [
        USAGE_AGGREGATE_SCHEDULER_ID,
        { every: 15_000 },
        { name: 'aggregate', opts: usageAggregateJobOptions() },
      ],
    ]);
    expect(USAGE_AGGREGATE_EVERY_MS).toBe(15_000);
    expect(usageAggregateJobOptions()).toMatchObject({
      attempts: 3,
      removeOnFail: { age: 604_800 },
    });
  });
});
