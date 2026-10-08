/**
 * Telemetry retention (B085) over the in-memory repository: a day is rolled up exactly once however
 * often the job runs, rollups hold counts only, partitions older than 90 days are dropped after
 * being rolled up, and a run after missed runs catches up.
 */
import { describe, expect, it } from 'vitest';
import { TelemetryRetention } from '../../src/modules/telemetry/retention.js';
import { DAY_MS, INSTALL, MemoryTelemetryRepository, T0 } from './helpers.js';

const day = (offset: number) => new Date(T0 + offset * DAY_MS).toISOString().slice(0, 10);

async function seed(repo: MemoryTelemetryRepository, offset: number, n = 3) {
  await repo.insert(
    day(offset),
    Array.from({ length: n }, (_, i) => ({
      install_id: INSTALL,
      type: i % 2 === 0 ? ('command.run' as const) : ('perf.startup' as const),
      at: new Date(T0 + offset * DAY_MS),
      props: (i % 2 === 0 ? { name: 'login' } : { ms: 800 + i }) as Record<string, string | number>,
    })),
  );
}

describe('rollups', () => {
  it('rolls the previous day up exactly once, with counts only', async () => {
    const repo = new MemoryTelemetryRepository();
    await seed(repo, -1, 5);
    await seed(repo, 0, 2);
    const retention = new TelemetryRetention({
      repository: repo,
      retentionDays: 90,
      clock: () => T0,
    });
    expect(await retention.rollup()).toEqual([day(-1)]);
    expect(await retention.rollup()).toEqual([]);
    expect(await retention.rollup(day(-1))).toEqual([]);
    expect(Object.fromEntries(repo.agg)).toEqual({
      [`${day(-1)}|command.run|*`]: 3,
      [`${day(-1)}|command.run|name=login`]: 3,
      [`${day(-1)}|perf.startup|*`]: 2,
    });
    // Today is not rolled up until it is over; numbers never reach the aggregates.
    expect([...repo.agg.keys()].some((k) => k.startsWith(day(0)) || k.includes('ms='))).toBe(false);
  });
});

describe('drops', () => {
  it('drops partitions older than 90 days, rolling them up first, and catches up after missed runs', async () => {
    const repo = new MemoryTelemetryRepository();
    for (const offset of [-95, -92, -91, -90, -89, -1]) await seed(repo, offset, 1);
    const retention = new TelemetryRetention({
      repository: repo,
      retentionDays: 90,
      clock: () => T0,
    });
    const dropped = await retention.drop();
    expect(dropped).toEqual(
      [-95, -92, -91].map((o) => `telemetry_events_${day(o).replaceAll('-', '')}`),
    );
    expect([...repo.partitions].sort()).toEqual([day(-90), day(-89), day(-1)]);
    // Every dropped day was rolled up before it went.
    for (const o of [-95, -92, -91]) expect(repo.rollups.has(day(o))).toBe(true);
    expect(await retention.drop()).toEqual([]);
    // An explicit date drops everything before it.
    expect(await retention.drop(day(-1))).toHaveLength(2);
    expect([...repo.partitions]).toEqual([day(-1)]);
  });
});
