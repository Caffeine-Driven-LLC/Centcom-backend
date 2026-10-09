/**
 * The module's wiring and settings (B048): `cursors/module.ts` is a RelayModule at order 36
 * (STAGE_ORDER.cursors) that adds the cursor stage, wires typing auto-clear to B047's presence when
 * the relay has it (and says so when not), forgets a member's slot and timer when it leaves the
 * session here, and stops on shutdown. RELAY_CURSOR_IN_PER_S, RELAY_CURSOR_TICK_MS,
 * RELAY_TYPING_TTL_MS and RELAY_CURSOR_MAX_CT_BYTES have the card's defaults.
 */
import { ConfigError, createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURSOR_IN_PER_S,
  DEFAULT_CURSOR_MAX_CT_BYTES,
  DEFAULT_CURSOR_TICK_MS,
  DEFAULT_TYPING_TTL_MS,
  loadCursorsConfig,
} from '../../src/cursors/config.js';
import relayModule, { createCursorsModule } from '../../src/cursors/module.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import type { PresenceUpdate } from '../../src/presence/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

function context(withPresence: boolean) {
  const pipeline = new FramePipeline();
  const steps: (() => Promise<void>)[] = [];
  const log = captureLogger();
  const listeners: ((sid: string, mid: string, p: PresenceUpdate, now: number) => void)[] = [];
  const ctx = {
    log: log.logger,
    metrics: recordingMetrics().metrics,
    clock: Date.now,
    db: {},
    redis: createMemoryRedis(),
    pipeline,
    onConnection: () => undefined,
    onShutdown: (fn: () => Promise<void>) => void steps.push(fn),
    ...(withPresence
      ? {
          presence: {
            update: () => undefined,
            onUpdate: (l: (typeof listeners)[number]) => void listeners.push(l),
          },
        }
      : {}),
  } as unknown as RelayContext;
  return { ctx, pipeline, steps, log, listeners };
}

describe('cursors/module.ts', () => {
  it('registers the stage at 36 and typing over presence; stops on shutdown', async () => {
    expect(relayModule).toMatchObject({ name: 'cursors', order: 36 });
    expect(STAGE_ORDER.cursors).toBe(36);
    const r = context(true);
    await createCursorsModule({}).register(r.ctx);
    expect(r.pipeline.orders()).toEqual([36]);
    expect(r.listeners).toHaveLength(1);
    expect(r.steps).toHaveLength(1);
    await r.steps[0]?.();
  });

  it('without presence: cursors only, and the log says so', async () => {
    const r = context(false);
    await createCursorsModule({}).register(r.ctx);
    expect(r.pipeline.orders()).toEqual([36]);
    expect(r.log.lines().map((l) => l['msg'])).toContain('relay.cursors_without_presence');
    await r.steps[0]?.();
  });
});

describe('loadCursorsConfig', () => {
  it("has the card's defaults and refuses bad values", () => {
    expect(loadCursorsConfig({})).toEqual({
      inPerSecond: DEFAULT_CURSOR_IN_PER_S,
      tickMs: DEFAULT_CURSOR_TICK_MS,
      typingTtlMs: DEFAULT_TYPING_TTL_MS,
      maxCtBytes: DEFAULT_CURSOR_MAX_CT_BYTES,
    });
    expect([
      DEFAULT_CURSOR_IN_PER_S,
      DEFAULT_CURSOR_TICK_MS,
      DEFAULT_TYPING_TTL_MS,
      DEFAULT_CURSOR_MAX_CT_BYTES,
    ]).toEqual([10, 100, 5_000, 4_096]);
    for (const bad of [{ RELAY_CURSOR_IN_PER_S: '0' }, { RELAY_CURSOR_MAX_CT_BYTES: '1' }]) {
      expect(() => loadCursorsConfig(bad)).toThrow(ConfigError);
    }
  });
});
