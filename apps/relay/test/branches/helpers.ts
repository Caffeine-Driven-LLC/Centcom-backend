/**
 * Test helpers for branch and conflict signalling (B061): frames built from
 * `contracts/fixtures/events/branch.update.json` and `conflict.detected.json` with fresh ids, the
 * handlers over B009's in-memory Redis (the real gate) with a fake clock, an agent directory and a
 * connected set, a recording emitter, a sequencer that numbers frames and de-duplicates by
 * `(from, id)` as B041 does, and the stage over a fixed room.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type KeyValue } from '@centcom/core';
import { BranchHandler } from '../../src/branches/branch-handler.js';
import { ConflictSignal, type ConflictSignalDeps } from '../../src/branches/conflict-signal.js';
import { redisSignalGate } from '../../src/branches/module.js';
import type { SignalFrame, SignalSender } from '../../src/branches/ports.js';
import { branchStage } from '../../src/branches/stage.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import type { SessionRole } from '../../src/rooms/kind-policy.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The fixture frame of `kind`. */
export function fixture(kind: 'branch.update' | 'conflict.detected'): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
}

/** A fixture frame as a client sends it (no server `from`, `ts` or `seq`). */
function clientFrame(frame: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(frame).filter(([key]) => !['seq', 'from', 'ts'].includes(key)),
  );
}

/** A full `branch.update` frame (fixture `ct`, fresh id). */
export function branchUpdate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...clientFrame(fixture('branch.update')), id: newId('msg'), ...over };
}

/** A full `conflict.detected` frame. */
export function conflict(agentIds: string[], pathHmacs: string[]): Record<string, unknown> {
  return {
    ...clientFrame(fixture('conflict.detected')),
    id: newId('msg'),
    p: { agent_ids: agentIds, path_hmacs: pathHmacs },
  };
}

/** Handlers, fakes and the stage. */
export function signalEnv(opts: { mode?: 'command_post' | 'branch' } = {}) {
  const clock = { now: Date.parse('2026-10-10T12:00:00.000Z') };
  const redis = createMemoryRedis(() => clock.now);
  const written: { key: string; value: string }[] = [];
  const down = { on: false };
  /** The agent registry alone is down (Redis up). */
  const registryDown = { on: false };
  const kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'> = {
    get: (k) => (down.on ? Promise.reject(new Error('redis down')) : redis.kv.get(k)),
    set: (k, v, o) => (written.push({ key: k, value: v }), redis.kv.set(k, v, o)),
    setIfAbsent: (k, v, ttl) => {
      if (down.on) return Promise.reject(new Error('redis down'));
      written.push({ key: k, value: v });
      return redis.kv.setIfAbsent(k, v, ttl);
    },
    del: (k) => redis.kv.del(k),
  };
  const sid = newId('ses');
  const member = (role: SessionRole): SignalSender => ({ memberId: newId('mem'), role });
  const host = member('host');
  const editor = member('editor');
  const viewer = member('viewer');
  /** Agent -> owner. */
  const agents = new Map<string, string>();
  /** Agents that exited. */
  const exited = new Set<string>();
  const connected = new Set<string>([host.memberId, editor.memberId, viewer.memberId]);
  const emitted: { sid: string; p: Record<string, unknown> }[] = [];
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const modes = { modeOf: () => Promise.resolve(opts.mode ?? 'command_post') };
  const conflictDeps: ConflictSignalDeps = {
    agents: {
      agents: () =>
        down.on || registryDown.on
          ? Promise.reject(new Error('registry down'))
          : Promise.resolve(
              [...agents].map(([agentId, owner]) => ({
                agentId,
                owner,
                exited: exited.has(agentId),
              })),
            ),
    },
    connected: { isConnected: (_sid, m) => Promise.resolve(connected.has(m)) },
    modes,
    gate: redisSignalGate({
      kv: kv as KeyValue,
      rateLimit: {
        // Recorded too, for the privacy scan.
        consume: (key, limit, windowS, cost) => {
          written.push({ key, value: '' });
          return redis.rateLimit.consume(key, limit, windowS, cost);
        },
      },
    }),
    emitter: {
      emit(s, p) {
        emitted.push({ sid: s, p });
        return Promise.resolve();
      },
    },
    logger: captured.logger,
    metrics: recorded.metrics,
  };
  const conflicts = new ConflictSignal(conflictDeps);
  const branches = new BranchHandler({ modes, metrics: recorded.metrics });
  const seen = new Map<string, number>();
  let head = 0;
  const sequenced: { frame: Record<string, unknown>; seq: number }[] = [];
  const agentOf = (owner: SignalSender): string => {
    const id = newId('agt');
    agents.set(id, owner.memberId);
    return id;
  };
  /** Runs `frame` through the stage as `by`; returns what the sender got and whether it passed. */
  const send = async (frame: Record<string, unknown>, by: SignalSender) => {
    const stage = branchStage({
      branches,
      conflicts,
      rooms: {
        locate: () =>
          ({
            room: { sid },
            member: { id: by.memberId, role: by.role, sid },
          }) as never,
      },
    });
    const sent: Record<string, unknown>[] = [];
    let passed = false;
    const fc: FrameContext = {
      connection: {
        send: (f: Record<string, unknown>) => (sent.push(f), true),
      } as unknown as RelayConnection,
      raw: JSON.stringify(frame),
      frame,
      state: {},
    };
    await stage(fc, () => {
      passed = true;
      const key = `${by.memberId}:${String(frame['id'])}`;
      if (!seen.has(key)) {
        head += 1;
        seen.set(key, head);
        sequenced.push({ frame, seq: head });
        fc.state[SEQUENCED_STATE_KEY] = { ...frame, seq: head } as unknown as StoredFrame;
      }
      return Promise.resolve();
    });
    return { sent, passed, error: sent.find((f) => f['t'] === 'sys.error') };
  };
  /** The handler entry points, with a sequencer that always stores. */
  const direct = (by: SignalSender) => ({
    sid,
    sender: by,
    sequence: () => Promise.resolve({ seq: ++head } as StoredFrame),
  });
  return {
    clock,
    redis,
    written,
    down,
    registryDown,
    sid,
    host,
    editor,
    viewer,
    agents,
    exited,
    connected,
    emitted,
    captured,
    recorded,
    conflicts,
    conflictDeps,
    branches,
    sequenced,
    agentOf,
    send,
    direct,
  };
}

export type SignalEnv = ReturnType<typeof signalEnv>;
export type { SignalFrame };
