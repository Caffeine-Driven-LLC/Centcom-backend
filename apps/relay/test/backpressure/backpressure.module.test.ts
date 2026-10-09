/**
 * The module's wiring and settings (B046): `backpressure/module.ts` is a RelayModule at order 55 that
 * attaches the controller to every connection, adds the `buffers` readiness check, sets
 * `ctx.backpressure` and stops on shutdown. RELAY_OUT_BUF_BYTES, RELAY_OUT_BUF_SOFT_BYTES,
 * RELAY_SLOW_GRACE_MS and RELAY_NODE_BUFFER_MAX have the card's defaults and refuse bad values.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_BUFFER_MAX,
  DEFAULT_OUT_BUF_BYTES,
  DEFAULT_OUT_BUF_SOFT_BYTES,
  DEFAULT_SLOW_GRACE_MS,
  loadBackpressureConfig,
} from '../../src/backpressure/config.js';
import relayModule, {
  BACKPRESSURE_ORDER,
  createBackpressureModule,
} from '../../src/backpressure/module.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { connectionSender } from '../../src/fanout/fanout.js';
import type { RelayContext } from '../../src/modules.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { recordingMetrics, captureLogger } from '../helpers.js';
import { bufferedConnection, MiB, presenceText } from './helpers.js';

describe('backpressure/module.ts', () => {
  it('is the module at order 55: attaches every connection, checks buffers, sets ctx.backpressure', async () => {
    expect(relayModule).toMatchObject({ name: 'backpressure', order: 55 });
    expect(BACKPRESSURE_ORDER).toBe(55);
    const handlers: ((c: RelayConnection) => void)[] = [];
    const checks = new Map<string, () => boolean>();
    const steps: (() => Promise<void>)[] = [];
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      onConnection: (h: (c: RelayConnection) => void) => void handlers.push(h),
      addReadinessCheck: (name: string, check: () => boolean) => void checks.set(name, check),
      onShutdown: (fn: () => Promise<void>) => void steps.push(fn),
    } as unknown as RelayContext;
    await createBackpressureModule({}).register(ctx);
    expect(handlers).toHaveLength(1);
    expect(checks.get('buffers')?.()).toBe(true);
    expect(ctx.backpressure).toBeDefined();
    const conn = bufferedConnection(new ConnectionRegistry({ max: 10 }));
    handlers[0]?.(conn);
    conn.buffered = 2 * MiB;
    expect(connectionSender(conn).send(presenceText('ses_x'), { droppable: true })).toBe('dropped');
    await steps[0]?.();
  });
});

describe('loadBackpressureConfig', () => {
  it("has the card's defaults", () => {
    expect(loadBackpressureConfig({})).toEqual({
      hardBytes: DEFAULT_OUT_BUF_BYTES,
      softBytes: DEFAULT_OUT_BUF_SOFT_BYTES,
      graceMs: DEFAULT_SLOW_GRACE_MS,
      nodeMaxBytes: DEFAULT_NODE_BUFFER_MAX,
    });
    expect([
      DEFAULT_OUT_BUF_BYTES,
      DEFAULT_OUT_BUF_SOFT_BYTES,
      DEFAULT_SLOW_GRACE_MS,
      DEFAULT_NODE_BUFFER_MAX,
    ]).toEqual([2_097_152, 1_048_576, 5_000, 1_073_741_824]);
  });

  it('refuses bad values and a soft mark at or above the hard one', () => {
    for (const bad of [
      { RELAY_OUT_BUF_BYTES: '1' },
      { RELAY_SLOW_GRACE_MS: '0' },
      { RELAY_NODE_BUFFER_MAX: '10' },
      { RELAY_OUT_BUF_SOFT_BYTES: '2097152' },
    ]) {
      expect(() => loadBackpressureConfig(bad), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });
});

describe('a connection that cannot report its buffer', () => {
  it('counts as empty, logged once', async () => {
    const { createBackpressure } = await import('../../src/backpressure/controller.js');
    const log = captureLogger();
    const controller = createBackpressure({
      config: loadBackpressureConfig({}),
      logger: log.logger,
    });
    const conn = bufferedConnection(new ConnectionRegistry({ max: 10 }));
    delete (conn as { bufferedBytes?: unknown }).bufferedBytes;
    controller.attach(conn);
    expect(controller.onEnqueue(conn, 10, true)).toBe('ok');
    expect(controller.onEnqueue(conn, 10, true)).toBe('ok');
    expect(
      log.lines().filter((l) => l['msg'] === 'relay.backpressure_no_buffer_info'),
    ).toHaveLength(1);
    controller.stop();
  });
});
