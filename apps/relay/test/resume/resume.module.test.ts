/**
 * The module's wiring and settings (B042): `resume/module.ts` is a RelayModule at order 45 that adds
 * the `sys.resume` stage at 45, sets `ctx.resume` for the handshake and B041's readiness gate, and,
 * with `OBJECT_STORE_*`, wires B041's DurableAppend to B055's store (flushed on shutdown). Without
 * an object store it says so, and production refuses to start. RELAY_REPLAY_BATCH,
 * RELAY_REPLAY_MAX_FRAMES and RELAY_HYDRATE_FRAMES have the card's defaults and refuse bad values.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import {
  DEFAULT_HYDRATE_FRAMES,
  DEFAULT_REPLAY_BATCH,
  DEFAULT_REPLAY_MAX_FRAMES,
  loadResumeConfig,
} from '../../src/resume/config.js';
import relayModule, { createResumeModule } from '../../src/resume/module.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import type { DurableAppend, SeqService } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { LIMITS } from '../seq/helpers.js';

const ENV = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'relay',
  PUBLIC_API_URL: 'https://api.centcom.test',
  DATABASE_URL: 'postgres://centcom@127.0.0.1:1/centcom',
  REDIS_URL: 'redis://127.0.0.1:1',
};

const OBJECT_STORE = {
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:1',
  OBJECT_STORE_BUCKET: 'centcom-history',
  OBJECT_STORE_ACCESS_KEY_ID: 'centcom',
  OBJECT_STORE_SECRET_ACCESS_KEY: 'dev-only',
};

/** The messages a captured logger logged. */
const messages = (log: ReturnType<typeof captureLogger>): unknown[] =>
  log.lines().map((line) => line['msg']);

/** A context with a sequence service double, recording what the module registers. */
function recordingContext(withSeq = true) {
  const pipeline = new FramePipeline();
  const steps: (() => Promise<void>)[] = [];
  const log = captureLogger();
  const ports: DurableAppend[] = [];
  let readiness: ((sid: string) => true | Promise<void>) | undefined;
  const seq: SeqService = {
    store: createMemorySeqStore(LIMITS),
    acks: { onAck: () => undefined, lowestAcked: () => 0, acked: () => 0 },
    setDurableAppend: (port) => void ports.push(port),
    delegateEcho: () => undefined,
    setReadiness: (ready) => void (readiness = ready),
    submitServer: () => Promise.reject(new Error('unused')),
    submitServerBatch: () => Promise.reject(new Error('unused')),
  };
  const ctx = {
    config: {},
    log: log.logger,
    metrics: recordingMetrics().metrics,
    clock: () => 0,
    db: {},
    pipeline,
    onConnection: () => undefined,
    onShutdown: (fn: () => Promise<void>) => void steps.push(fn),
    ...(withSeq ? { seq } : {}),
  } as unknown as RelayContext;
  return { ctx, pipeline, steps, log, ports, readiness: () => readiness };
}

describe('resume/module.ts', () => {
  it('is the module at order 45 (STAGE_ORDER.resume, between sequencing and fan-out)', () => {
    expect(relayModule).toMatchObject({ name: 'resume', order: 45 });
    expect(STAGE_ORDER.resume).toBe(45);
    expect(STAGE_ORDER.sequence).toBeLessThan(45);
    expect(STAGE_ORDER.fanOut).toBeGreaterThan(45);
  });

  it('registers the stage at 45, ctx.resume and the readiness gate; no store, no durable log', async () => {
    const r = recordingContext();
    await createResumeModule(ENV).register(r.ctx);
    expect(r.pipeline.orders()).toEqual([45]);
    expect(r.ctx.resume).toMatchObject({
      hold: expect.any(Function),
      prepare: expect.any(Function),
      start: expect.any(Function),
      abandon: expect.any(Function),
    });
    expect(r.readiness()).toEqual(expect.any(Function));
    expect(r.ports).toEqual([]);
    expect(messages(r.log)).toContain('relay.resume_without_durable_log');
  });

  it('with an object store, writes every frame to the durable log and flushes it on shutdown', async () => {
    const r = recordingContext();
    await createResumeModule({ ...ENV, ...OBJECT_STORE }).register(r.ctx);
    expect(r.ports).toHaveLength(1);
    expect(r.steps).toHaveLength(1);
    await expect(r.steps[0]?.()).resolves.toBeUndefined();
    expect(messages(r.log)).not.toContain('relay.resume_without_durable_log');
  });

  it('registers nothing without sequencing, and says so', async () => {
    const r = recordingContext(false);
    await createResumeModule(ENV).register(r.ctx);
    expect(r.pipeline.orders()).toEqual([]);
    expect(r.ctx.resume).toBeUndefined();
    expect(messages(r.log)).toContain('relay.resume_without_seq');
  });
});

describe('loadResumeConfig', () => {
  it("has the card's defaults and no object store", () => {
    expect(loadResumeConfig(ENV)).toEqual({
      batch: DEFAULT_REPLAY_BATCH,
      maxFrames: DEFAULT_REPLAY_MAX_FRAMES,
      hydrateFrames: DEFAULT_HYDRATE_FRAMES,
      objectStore: null,
    });
    expect([DEFAULT_REPLAY_BATCH, DEFAULT_REPLAY_MAX_FRAMES, DEFAULT_HYDRATE_FRAMES]).toEqual([
      100, 50_000, 5_000,
    ]);
  });

  it('reads the object store when it is configured, the secrets kept secret', () => {
    const config = loadResumeConfig({ ...ENV, ...OBJECT_STORE, RELAY_REPLAY_BATCH: '250' });
    expect(config.batch).toBe(250);
    expect(config.objectStore).toMatchObject({
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      bucket: 'centcom-history',
    });
    expect(JSON.stringify(config)).not.toContain('dev-only');
  });

  it('refuses bad values, a half-configured store, and production without one', () => {
    for (const bad of [
      { RELAY_REPLAY_BATCH: '0' },
      { RELAY_REPLAY_BATCH: '1001' },
      { RELAY_REPLAY_MAX_FRAMES: '0' },
      { RELAY_HYDRATE_FRAMES: '20001' },
      { OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:1' },
      { NODE_ENV: 'production' },
    ]) {
      expect(() => loadResumeConfig({ ...ENV, ...bad }), JSON.stringify(bad)).toThrow(ConfigError);
    }
    expect(
      loadResumeConfig({ ...ENV, ...OBJECT_STORE, NODE_ENV: 'production' }).objectStore,
    ).not.toBeNull();
  });
});
