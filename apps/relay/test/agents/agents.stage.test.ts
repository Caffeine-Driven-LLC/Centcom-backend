/**
 * B057 wiring: the agents stage routes a welcomed member's `agent.*` frames to the registry with
 * the rest of the pipeline as the sequence step, answers a refusal with `sys.error` (the frame's id
 * as `ref`) to the sender only, says nothing for a dropped frame, and passes every other frame on;
 * `agents/module.ts` registers the stage at 39 (before sequencing) and sets `ctx.agents`.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { agentStage } from '../../src/agents/handler.js';
import { guardMetrics } from '../../src/privacy/metrics.js';
import relayModule from '../../src/agents/module.js';
import type { RelayContext } from '../../src/modules.js';
import {
  FramePipeline,
  STAGE_ORDER,
  type FrameContext,
  type RelayConnection,
} from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { agentEnv, spawn, state } from './helpers.js';

/** A connection recording what it was sent. */
function connection() {
  const sent: Record<string, unknown>[] = [];
  const conn = {
    send: (f: object) => (sent.push(f as Record<string, unknown>), true),
  } as unknown as RelayConnection;
  return { conn, sent };
}

/** The stage over `env`'s registry, the sender in `env.sid` with `role`. */
function stageFor(
  env: ReturnType<typeof agentEnv>,
  member: { memberId: string; role: 'host' | 'editor' | 'viewer' },
) {
  const stage = agentStage({
    registry: env.registry,
    rooms: {
      locate: () =>
        ({
          room: { sid: env.sid },
          member: { id: member.memberId, role: member.role, sid: env.sid },
        }) as never,
    },
  });
  let seq = 0;
  return async (frame: Record<string, unknown>) => {
    const { conn, sent } = connection();
    const fc: FrameContext = { connection: conn, raw: null, frame, state: {} };
    let nexts = 0;
    await stage(fc, () => {
      nexts += 1;
      seq += 1;
      fc.state[SEQUENCED_STATE_KEY] = { ...frame, seq, ts: '2026-10-10T12:00:00.000Z' };
      return Promise.resolve();
    });
    return { sent, nexts };
  };
}

const wire = (f: { id: string; k: string; p: unknown }) => ({ v: 1, t: 'event', ...f });

describe('the agents stage', () => {
  it('sequences an accepted frame once and answers nothing', async () => {
    const env = agentEnv();
    const run = stageFor(env, env.host);
    const s = spawn({ owner: env.host.memberId });
    const out = await run(wire(s));
    expect(out).toEqual({ sent: [], nexts: 1 });
    expect(env.registry.get(env.sid, s.agentId)).toBeDefined();
  });

  it('answers a refusal with sys.error to the sender, ref = frame id, not sequenced', async () => {
    const env = agentEnv();
    const run = stageFor(env, env.editor);
    const s = spawn({ owner: env.editor.memberId });
    const out = await run(wire(s));
    expect(out.nexts).toBe(0);
    expect(out.sent).toEqual([
      expect.objectContaining({
        t: 'sys.error',
        ref: s.id,
        p: expect.objectContaining({ code: 'forbidden' }),
      }),
    ]);
    expect((await run(wire(state(newId('agt'), 'thinking')))).sent[0]).toMatchObject({
      p: { code: 'forbidden' },
    });
    const unknown = await stageFor(env, env.host)(wire(state(newId('agt'), 'thinking')));
    expect(unknown.sent[0]).toMatchObject({ p: { code: 'invalid_frame' } });
  });

  it('says nothing for a dropped frame', async () => {
    const env = agentEnv();
    const run = stageFor(env, env.host);
    const s = spawn({ owner: env.host.memberId });
    await run(wire(s));
    await run(wire(state(s.agentId, 'thinking')));
    const repeat = await run(wire(state(s.agentId, 'thinking')));
    expect(repeat).toEqual({ sent: [], nexts: 0 });
  });

  it('answers 503 when the store cannot be reached, and passes other frames on', async () => {
    const env = agentEnv({
      overrides: {
        store: {
          withSession: () => Promise.reject(new Error('redis and postgres down')),
          read: () => Promise.reject(new Error('down')),
        },
      },
    });
    const run = stageFor(env, env.host);
    const out = await run(wire(spawn({ owner: env.host.memberId })));
    expect(out.sent[0]).toMatchObject({ t: 'sys.error', p: { code: 'service_unavailable' } });
    expect(out.nexts).toBe(0);
    for (const other of [
      { v: 1, t: 'event', id: newId('msg'), k: 'message.user' },
      { v: 1, t: 'queue', id: newId('msg'), k: 'agent.spawn' },
      'not a frame',
    ]) {
      expect(await run(other as never)).toEqual({ sent: [], nexts: 1 });
    }
  });
});

describe('errors after sequencing', () => {
  it('rethrows to the pipeline instead of answering 503 for a frame already sequenced', async () => {
    const env = agentEnv();
    const stage = agentStage({
      registry: env.registry,
      rooms: {
        locate: () =>
          ({
            room: { sid: env.sid },
            member: { id: env.host.memberId, role: 'host', sid: env.sid },
          }) as never,
      },
    });
    const { conn, sent } = connection();
    const s = spawn({ owner: env.host.memberId });
    const fc: FrameContext = { connection: conn, raw: null, frame: wire(s), state: {} };
    await expect(stage(fc, () => Promise.reject(new Error('fan-out failed')))).rejects.toThrow(
      'fan-out failed',
    );
    expect(sent).toEqual([]);
  });
});

describe('agents/module.ts', () => {
  it('registers the stage at 39, before sequencing, and sets ctx.agents', async () => {
    expect(relayModule).toMatchObject({ name: 'agents', order: 39 });
    expect(STAGE_ORDER.control).toBeLessThan(39);
    expect(39).toBeLessThan(STAGE_ORDER.sequence);
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
    expect(ctx.agents?.list('ses_x')).toEqual([]);
  });

  it('reads relay_agents_live{mode} through the relay guard (guardMetrics) at each export', async () => {
    const gauges = new Map<string, () => unknown>();
    const ctx = {
      log: captureLogger().logger,
      // startRelay hands modules guardMetrics(metrics): the gauge must pass through it.
      metrics: guardMetrics({
        ...recordingMetrics().metrics,
        gauge: (name: string, read: () => unknown) => void gauges.set(name, read),
      } as never),
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline: new FramePipeline(),
      onConnection: () => undefined,
      onShutdown: () => undefined,
    } as unknown as RelayContext;
    await relayModule.register(ctx);
    expect(await gauges.get('relay_agents_live')?.()).toEqual([
      { value: 0, labels: { mode: 'command_post' } },
      { value: 0, labels: { mode: 'branch' } },
    ]);
  });
});
