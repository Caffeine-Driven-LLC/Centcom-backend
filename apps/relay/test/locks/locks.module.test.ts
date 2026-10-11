/**
 * B059 wiring: `locks/module.ts` registers the locks stage at 39 (before sequencing), exports the
 * `relay_locks_held` gauge through the relay's metric guard, and stops its sweep on shutdown.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import relayModule from '../../src/locks/module.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import { guardMetrics } from '../../src/privacy/metrics.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

describe('locks/module.ts', () => {
  it('registers the stage at 39, the gauge, and a sweep stopped on shutdown', async () => {
    expect(relayModule).toMatchObject({ name: 'locks', order: 39 });
    expect(STAGE_ORDER.control).toBeLessThan(39);
    expect(39).toBeLessThan(STAGE_ORDER.sequence);
    const pipeline = new FramePipeline();
    const gauges = new Map<string, () => unknown>();
    const shutdown: (() => Promise<void>)[] = [];
    const ctx = {
      log: captureLogger().logger,
      metrics: guardMetrics({
        ...recordingMetrics().metrics,
        gauge: (name: string, read: () => unknown) => void gauges.set(name, read),
      } as never),
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline,
      onConnection: () => undefined,
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
    } as unknown as RelayContext;
    await relayModule.register(ctx);
    expect(pipeline.orders()).toEqual([39]);
    expect(await gauges.get('relay_locks_held')?.()).toBe(0);
    expect(shutdown).toHaveLength(1);
    await shutdown[0]?.();
  });
});
