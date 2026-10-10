/**
 * The module's wiring (B052): `queue/module.ts` is a RelayModule at order 39 (STAGE_ORDER.queue,
 * after the control stage, before sequencing) that adds the queue stage and sets `ctx.queue`.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import relayModule from '../../src/queue/module.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

describe('queue/module.ts', () => {
  it('registers the stage at 39 and ctx.queue', async () => {
    expect(relayModule).toMatchObject({ name: 'queue', order: 39 });
    expect(STAGE_ORDER.control).toBeLessThan(STAGE_ORDER.queue);
    expect(STAGE_ORDER.queue).toBeLessThan(STAGE_ORDER.sequence);
    const pipeline = new FramePipeline();
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline,
      onConnection: () => undefined,
      onShutdown: () => undefined,
    } as unknown as RelayContext;
    await relayModule.register(ctx);
    expect(pipeline.orders()).toEqual([39]);
    expect(ctx.queue?.snapshot('ses_x')).toEqual({ version: 0, items: [] });
  });
});
