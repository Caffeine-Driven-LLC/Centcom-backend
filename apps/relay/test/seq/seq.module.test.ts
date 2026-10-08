/**
 * The module's wiring and settings (B041): `seq/module.ts` is a RelayModule at order 40 that adds
 * the sequence stage at 40, handles every connection, sets `ctx.seq` and closes its Redis
 * connection on shutdown, without waiting for Redis. RELAY_SEQ_* and RELAY_BUF_* have the
 * contract's defaults, refuse bad values, and the rate and burst are what `sys.welcome` advertises.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { WELCOME_LIMITS, welcomeFrame } from '../../src/handshake/handshake.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER, type RelayConnection } from '../../src/pipeline.js';
import {
  DEFAULT_SEQ_BURST,
  DEFAULT_SEQ_RATE,
  loadSeqConfig,
  welcomeSeqLimits,
} from '../../src/seq/config.js';
import relayModule, { createSeqModule } from '../../src/seq/module.js';
import { captureLogger, recordingMetrics, testRelay } from '../helpers.js';

/** Settings with a Redis nobody answers on (nothing here may wait for it). */
const ENV = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'relay',
  PUBLIC_API_URL: 'https://api.centcom.test',
  DATABASE_URL: 'postgres://centcom@127.0.0.1:1/centcom',
  REDIS_URL: 'redis://127.0.0.1:1',
};

/** A context recording what a module registers. */
function recordingContext(): {
  ctx: RelayContext;
  pipeline: FramePipeline;
  handlers: ((c: RelayConnection) => void)[];
  steps: (() => Promise<void>)[];
} {
  const pipeline = new FramePipeline();
  const handlers: ((c: RelayConnection) => void)[] = [];
  const steps: (() => Promise<void>)[] = [];
  const ctx = {
    config: {},
    log: captureLogger().logger,
    metrics: recordingMetrics().metrics,
    clock: () => 0,
    pipeline,
    onConnection: (h: (c: RelayConnection) => void) => handlers.push(h),
    onShutdown: (fn: () => Promise<void>) => steps.push(fn),
  } as unknown as RelayContext;
  return { ctx, pipeline, handlers, steps };
}

describe('seq/module.ts', () => {
  it('is the module at order 40 (STAGE_ORDER.sequence)', () => {
    expect(relayModule).toMatchObject({ name: 'seq', order: 40 });
    expect(STAGE_ORDER.sequence).toBe(40);
  });

  it('registers the stage at 40, a connection handler, ctx.seq and a shutdown step, without waiting for Redis', async () => {
    const { ctx, pipeline, handlers, steps } = recordingContext();
    const started = Date.now();
    await createSeqModule(ENV).register(ctx);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pipeline.orders()).toEqual([40]);
    expect(handlers).toHaveLength(1);
    expect(ctx.seq).toMatchObject({
      store: expect.any(Object),
      acks: expect.any(Object),
      setDurableAppend: expect.any(Function),
    });
    expect(steps).toHaveLength(1);
    await expect(steps[0]?.()).resolves.toBeUndefined();
  });

  it('refuses to register with a bad setting (the relay does not start)', () => {
    const { ctx } = recordingContext();
    expect(() => createSeqModule({ ...ENV, RELAY_SEQ_RATE: '0' }).register(ctx)).toThrow(
      ConfigError,
    );
    expect(() => createSeqModule({ NODE_ENV: 'test' }).register(ctx)).toThrow(ConfigError);
  });

  it('starts on a relay and is logged as registered', async () => {
    const relay = await testRelay({ modules: [createSeqModule(ENV)] });
    try {
      expect(relay.log.lines().find((l) => l['msg'] === 'relay.module_registered')).toMatchObject({
        module: 'seq',
        order: 40,
      });
    } finally {
      await relay.stop();
      for (const step of relay.shutdownSteps) await step();
    }
  });
});

describe('the advertised limits', () => {
  it('match the contract defaults the handshake advertised before', () => {
    expect([DEFAULT_SEQ_RATE, DEFAULT_SEQ_BURST]).toEqual([
      WELCOME_LIMITS.seq_rate,
      WELCOME_LIMITS.seq_burst,
    ]);
    expect(welcomeSeqLimits(loadSeqConfig({}))).toEqual({ seq_rate: 30, seq_burst: 100 });
  });

  it('are what sys.welcome carries when configured', () => {
    const access = {
      session: { state: 'live' as const, maxMembers: 4 },
      member: {
        id: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        name: 'Alex',
        slot: 0,
        role: 'host' as const,
      },
      deviceRevoked: false,
      relayAccess: true,
    };
    const configured = welcomeFrame({
      protocol: 1,
      caps: [],
      access,
      nowMs: 0,
      seqLimits: welcomeSeqLimits(loadSeqConfig({ RELAY_SEQ_RATE: '12', RELAY_SEQ_BURST: '34' })),
    }) as { p: { limits: Record<string, number> } };
    expect(configured.p.limits).toMatchObject({ seq_rate: 12, seq_burst: 34, max_members: 4 });
    const plain = welcomeFrame({ protocol: 1, caps: [], access, nowMs: 0 }) as {
      p: { limits: Record<string, number> };
    };
    expect(plain.p.limits).toMatchObject({ seq_rate: 30, seq_burst: 100 });
  });
});
