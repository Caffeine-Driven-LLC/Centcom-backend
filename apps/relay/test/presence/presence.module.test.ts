/**
 * The module's wiring and settings (B047): `presence/module.ts` is a RelayModule at order 35
 * (STAGE_ORDER.presence) that adds the presence stage, sets `ctx.presence`, follows B043's joins
 * and leaves, and closes its Redis connection on shutdown without waiting for Redis.
 * RELAY_PRESENCE_IN_MS, RELAY_PRESENCE_OUT_MS and RELAY_OFFLINE_GRACE_MS have the card's defaults.
 */
import { ConfigError, createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import {
  DEFAULT_OFFLINE_GRACE_MS,
  DEFAULT_PRESENCE_IN_MS,
  DEFAULT_PRESENCE_OUT_MS,
  loadPresenceConfig,
} from '../../src/presence/config.js';
import relayModule, { createPresenceModule } from '../../src/presence/module.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

const ENV = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'relay',
  PUBLIC_API_URL: 'https://api.centcom.test',
  DATABASE_URL: 'postgres://centcom@127.0.0.1:1/centcom',
  REDIS_URL: 'redis://127.0.0.1:1',
};

describe('presence/module.ts', () => {
  it('registers the stage at 35 and ctx.presence, without waiting for Redis', async () => {
    expect(relayModule).toMatchObject({ name: 'presence', order: 35 });
    expect(STAGE_ORDER.presence).toBe(35);
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
    await createPresenceModule(ENV).register(ctx);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pipeline.orders()).toEqual([35]);
    expect(ctx.presence).toBeDefined();
    expect(steps).toHaveLength(1);
    await steps[0]?.();
  });
});

describe('loadPresenceConfig', () => {
  it("has the card's defaults and refuses bad values", () => {
    expect(loadPresenceConfig({})).toEqual({
      inMs: DEFAULT_PRESENCE_IN_MS,
      outMs: DEFAULT_PRESENCE_OUT_MS,
      offlineGraceMs: DEFAULT_OFFLINE_GRACE_MS,
    });
    expect([DEFAULT_PRESENCE_IN_MS, DEFAULT_PRESENCE_OUT_MS, DEFAULT_OFFLINE_GRACE_MS]).toEqual([
      1_000, 500, 10_000,
    ]);
    for (const bad of [{ RELAY_PRESENCE_IN_MS: '-1' }, { RELAY_OFFLINE_GRACE_MS: '600001' }]) {
      expect(() => loadPresenceConfig(bad)).toThrow(ConfigError);
    }
  });
});
