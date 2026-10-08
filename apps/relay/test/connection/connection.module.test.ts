/**
 * The module's wiring and settings (B040): `connection/module.ts` is a RelayModule at order 12
 * that adds the activity stage at 5 and its own at 12 (around the codec at 10, before the
 * handshake at 15), handles every connection and stops on shutdown. RELAY_PING_MS and
 * RELAY_DEAD_MS have the contract's defaults, refuse bad values, and are what the handshake's
 * module advertises in `sys.welcome`.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEAD_MS,
  DEFAULT_PING_MS,
  loadHeartbeatConfig,
  welcomeHeartbeat,
} from '../../src/connection/config.js';
import relayModule from '../../src/connection/module.js';
import { HEARTBEAT, welcomeFrame } from '../../src/handshake/handshake.js';
import { FramePipeline, STAGE_ORDER, type RelayConnection } from '../../src/pipeline.js';
import type { RelayContext } from '../../src/modules.js';
import { captureLogger, recordingMetrics, testRelay } from '../helpers.js';

describe('connection/module.ts', () => {
  it('registers at order 12: stages at 5 and 12, a connection handler and a shutdown step', async () => {
    expect(relayModule).toMatchObject({ name: 'connection', order: 12 });
    expect([
      STAGE_ORDER.activity,
      STAGE_ORDER.decode,
      STAGE_ORDER.heartbeat,
      STAGE_ORDER.handshake,
    ]).toEqual([5, 10, 12, 15]);
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
    await relayModule.register(ctx);
    expect(pipeline.orders()).toEqual([5, 12]);
    expect(handlers).toHaveLength(1);
    expect(steps).toHaveLength(1);
    await expect(steps[0]?.()).resolves.toBeUndefined();
  });

  it('starts on a relay and is logged as registered', async () => {
    const relay = await testRelay({ modules: [relayModule] });
    try {
      expect(relay.log.lines().find((l) => l['msg'] === 'relay.module_registered')).toMatchObject({
        module: 'connection',
        order: 12,
      });
    } finally {
      await relay.stop();
    }
  });
});

describe('loadHeartbeatConfig', () => {
  it('has the CT-WS-ENVELOPE defaults, the same the welcome advertised before', () => {
    expect(loadHeartbeatConfig({})).toEqual({ pingMs: 20_000, deadMs: 50_000 });
    expect(welcomeHeartbeat(loadHeartbeatConfig({}))).toEqual(HEARTBEAT);
    expect([DEFAULT_PING_MS, DEFAULT_DEAD_MS]).toEqual([20_000, 50_000]);
  });

  it('reads its keys', () => {
    expect(loadHeartbeatConfig({ RELAY_PING_MS: '10000', RELAY_DEAD_MS: '25000' })).toEqual({
      pingMs: 10_000,
      deadMs: 25_000,
    });
  });

  it.each([
    [{ RELAY_PING_MS: 'soon' }],
    [{ RELAY_PING_MS: '500' }],
    [{ RELAY_DEAD_MS: '1000000' }],
    [{ RELAY_PING_MS: '30000', RELAY_DEAD_MS: '50000' }],
  ])('refuses %j', (env) => {
    expect(() => loadHeartbeatConfig(env)).toThrow(ConfigError);
  });

  it('is what sys.welcome advertises', () => {
    const access = {
      session: { state: 'live' as const, maxMembers: 12 },
      member: { id: 'mem_x', name: 'A', slot: 0, role: 'editor' as const },
      deviceRevoked: false,
      relayAccess: true,
      rosterV: 1,
    };
    const config = loadHeartbeatConfig({ RELAY_PING_MS: '15000', RELAY_DEAD_MS: '40000' });
    const frame = welcomeFrame({
      protocol: 1,
      caps: [],
      access,
      nowMs: 0,
      heartbeat: welcomeHeartbeat(config),
    }) as { p: { heartbeat: unknown } };
    expect(frame.p.heartbeat).toEqual({ ping_ms: 15_000, dead_ms: 40_000 });
    const plain = welcomeFrame({ protocol: 1, caps: [], access, nowMs: 0 }) as {
      p: { heartbeat: unknown };
    };
    expect(plain.p.heartbeat).toEqual({ ping_ms: 20_000, dead_ms: 50_000 });
  });
});
