/**
 * The `telemetry-retention` queue (B085): `rollup {day?}` and `drop {before?}` jobs call the API's
 * TelemetryRetention, bad dates are refused without retries, and both run daily (UTC) with retries.
 */
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  processTelemetryRetention,
  scheduleTelemetryRetention,
  TELEMETRY_DROP_SCHEDULER_ID,
  TELEMETRY_RETENTION_QUEUE,
  TELEMETRY_ROLLUP_SCHEDULER_ID,
  telemetryRetentionJobOptions,
} from '../src/jobs/telemetry-retention/index.js';

function deps() {
  const calls: string[] = [];
  return {
    calls,
    rollup: (day?: string) => {
      calls.push(`rollup ${day ?? '-'}`);
      return Promise.resolve(day === undefined ? ['2026-11-02'] : [day]);
    },
    drop: (before?: string) => {
      calls.push(`drop ${before ?? '-'}`);
      return Promise.resolve(['telemetry_events_20260801']);
    },
  };
}

describe('telemetry-retention jobs', () => {
  it('runs rollup and drop with or without their date', async () => {
    const d = deps();
    expect(await processTelemetryRetention({ name: 'rollup', data: {} }, d)).toEqual({
      days: ['2026-11-02'],
    });
    expect(
      await processTelemetryRetention({ name: 'rollup', data: { day: '2026-11-01' } }, d),
    ).toEqual({ days: ['2026-11-01'] });
    await processTelemetryRetention({ name: 'drop', data: {} }, d);
    await processTelemetryRetention({ name: 'drop', data: { before: '2026-08-05' } }, d);
    expect(d.calls).toEqual(['rollup -', 'rollup 2026-11-01', 'drop -', 'drop 2026-08-05']);
    expect(TELEMETRY_RETENTION_QUEUE).toBe('telemetry-retention');
  });

  it('refuses bad dates and unknown jobs without retrying', async () => {
    const d = deps();
    for (const job of [
      { name: 'rollup', data: { day: '2026-1-1' } },
      { name: 'drop', data: { before: 20260801 } },
      { name: 'vacuum', data: {} },
    ]) {
      await expect(processTelemetryRetention(job, d)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(d.calls).toEqual([]);
  });

  it('schedules a daily rollup and drop in UTC, with three attempts', async () => {
    const calls: unknown[][] = [];
    await scheduleTelemetryRetention({
      upsertJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(args)),
    } as never);
    expect(calls).toEqual([
      [
        TELEMETRY_ROLLUP_SCHEDULER_ID,
        { pattern: '10 0 * * *', tz: 'UTC' },
        { name: 'rollup', data: {}, opts: telemetryRetentionJobOptions() },
      ],
      [
        TELEMETRY_DROP_SCHEDULER_ID,
        { pattern: '20 0 * * *', tz: 'UTC' },
        { name: 'drop', data: {}, opts: telemetryRetentionJobOptions() },
      ],
    ]);
    expect(telemetryRetentionJobOptions()).toMatchObject({
      attempts: 3,
      removeOnFail: { age: 604_800 },
    });
  });
});
