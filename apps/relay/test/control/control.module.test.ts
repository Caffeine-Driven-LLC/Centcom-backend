/**
 * The module's wiring (B051): `control/module.ts` is a RelayModule at order 38
 * (STAGE_ORDER.control, after authorisation and the privacy gate, before sequencing) that adds the
 * control stage, plugs its mutes and its audit of refused control frames into B043's rooms, sets
 * `ctx.control`, and stops its marker refresh on shutdown.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import relayModule from '../../src/control/module.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

describe('control/module.ts', () => {
  it('registers the stage at 38, the mutes and denied-audit hooks, and ctx.control', async () => {
    expect(relayModule).toMatchObject({ name: 'control', order: 38 });
    expect(STAGE_ORDER.authorise).toBeLessThan(STAGE_ORDER.control);
    expect(STAGE_ORDER.privacy).toBeLessThan(STAGE_ORDER.control);
    expect(STAGE_ORDER.control).toBeLessThan(STAGE_ORDER.sequence);
    const pipeline = new FramePipeline();
    const steps: (() => Promise<void>)[] = [];
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline,
      onConnection: () => undefined,
      onShutdown: (fn: () => Promise<void>) => void steps.push(fn),
    } as unknown as RelayContext;
    await relayModule.register(ctx);
    expect(pipeline.orders()).toEqual([38]);
    expect(ctx.control?.policies).toBeDefined();
    expect(ctx.control?.mutes).toBeDefined();
    // B043's mute state now asks the control lane's registry, which reads the session's mutes
    // (from this test's empty database: the read fails, so the frame would be refused).
    const loading = roomsFor(ctx).mute.ready?.('ses_x');
    expect(loading).toBeInstanceOf(Promise);
    await expect(loading).rejects.toThrow();
    expect(steps).toHaveLength(1);
    await steps[0]?.();
  });
});
