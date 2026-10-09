/**
 * The module's wiring (B049): `keys/module.ts` is a RelayModule at order 25 (STAGE_ORDER.keys) that
 * adds the validation stage at 25 and the rotation stage at 41 (STAGE_ORDER.rotate, after
 * sequencing), sets `ctx.epoch`, and closes its Redis connection on shutdown without waiting for
 * Redis.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import relayModule, { createKeysModule } from '../../src/keys/module.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

const ENV = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'relay',
  PUBLIC_API_URL: 'https://api.centcom.test',
  DATABASE_URL: 'postgres://centcom@127.0.0.1:1/centcom',
  REDIS_URL: 'redis://127.0.0.1:1',
};

describe('keys/module.ts', () => {
  it('registers stages at 25 and 41 and ctx.epoch, without waiting for Redis', async () => {
    expect(relayModule).toMatchObject({ name: 'keys', order: 25 });
    expect([STAGE_ORDER.keys, STAGE_ORDER.rotate]).toEqual([25, 41]);
    expect(STAGE_ORDER.authorise).toBeLessThan(25);
    expect(STAGE_ORDER.sequence).toBeLessThan(41);
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
    const started = Date.now();
    await createKeysModule(ENV).register(ctx);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pipeline.orders()).toEqual([25, 41]);
    expect(ctx.epoch).toBeDefined();
    await steps[0]?.();
  });
});
