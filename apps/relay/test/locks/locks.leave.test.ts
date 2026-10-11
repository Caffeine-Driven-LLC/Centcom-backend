/**
 * B059 member leaves through the module's wiring (guardrail: member left): the module records a
 * member's first connection on this node, and when its last one closes and it is connected on no
 * node, frees its locks after LEAVE_GRACE_MS unless it came back. Join and leave writes for one
 * member run in the order this node saw them, even when the session mutex is busy, so a quick
 * reconnect never loses its locks.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import relayModule from '../../src/locks/module.js';
import { LEAVE_GRACE_MS } from '../../src/locks/ports.js';
import { createRedisLockStore } from '../../src/locks/store.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline } from '../../src/pipeline.js';
import type { MemberView } from '../../src/rooms/registry.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { fakeConnection } from '../rooms/helpers.js';

async function setup() {
  const memory = createMemoryRedis();
  // `slowNext`: the next mutex attempt takes 30 ms (a slow round trip), so a later one can pass it.
  const slow = { next: false, fail: 0 };
  const redis = {
    ...memory,
    kv: {
      ...memory.kv,
      setIfAbsent: async (k: string, v: string, ttl: number) => {
        if (slow.fail > 0 && k.endsWith(':mutex')) {
          slow.fail -= 1;
          throw new Error('redis down');
        }
        if (slow.next && k.endsWith(':mutex')) {
          slow.next = false;
          await new Promise((r) => setTimeout(r, 30));
        }
        return memory.kv.setIfAbsent(k, v, ttl);
      },
    },
  };
  const emitted: Record<string, unknown>[] = [];
  const shutdown: (() => Promise<void>)[] = [];
  const ctx = {
    log: captureLogger().logger,
    metrics: recordingMetrics().metrics,
    clock: Date.now,
    db: {},
    redis,
    pipeline: new FramePipeline(),
    fanout: {
      emitServerBatch: (_sid: string, frames: { p: Record<string, unknown> }[]) => {
        emitted.push(...frames.map((f) => f.p));
        return Promise.resolve([]);
      },
    },
    onConnection: () => undefined,
    onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
  } as unknown as RelayContext;
  await relayModule.register(ctx);
  const sid = newId('ses');
  const member: MemberView = {
    id: newId('mem'),
    sid,
    role: 'editor',
    userId: newId('usr'),
    workspaceId: newId('wsp'),
    name: 'Alex',
    slot: 0,
  };
  const agent = newId('agt');
  // Three locks held by the member's agent.
  await createRedisLockStore({ kv: redis.kv, clock: Date.now }).withSession(sid, async (tx) => {
    const state = await tx.load();
    for (const path of ['p1', 'p2', 'p3']) {
      state.locks.set(path, {
        agent,
        member: member.id,
        expiresAt: Date.now() + 300_000,
        ttlMs: 300_000,
      });
    }
    await tx.save(state);
  });
  const registry = roomsFor(ctx).registry;
  const expires = () => emitted.filter((p) => p['action'] === 'expire');
  return { ctx, redis, slow, sid, member, registry, expires, shutdown };
}

describe('member leaves through the module', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a member gone for the grace loses its 3 locks; not before', async () => {
    const env = await setup();
    const conn = fakeConnection(env.sid);
    env.registry.getOrCreate(env.sid).join(conn, env.member);
    await vi.advanceTimersByTimeAsync(10);
    env.registry.getOrCreate(env.sid).leave(conn);
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS - 100);
    expect(env.expires()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(env.expires()).toHaveLength(3);
  });

  it('a member back within the grace keeps its locks', async () => {
    const env = await setup();
    env.registry.getOrCreate(env.sid).join(fakeConnection(env.sid), env.member);
    await vi.advanceTimersByTimeAsync(10);
    const room = env.registry.getOrCreate(env.sid);
    const [first] = room.connectionsOf(env.member.id);
    room.leave(first as never);
    await vi.advanceTimersByTimeAsync(3_000);
    env.registry.getOrCreate(env.sid).join(fakeConnection(env.sid), env.member);
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS * 2);
    expect(env.expires()).toHaveLength(0);
  });

  it('a reconnect overtaking its leave on the way to Redis keeps the locks (writes stay in order)', async () => {
    const env = await setup();
    const room = env.registry.getOrCreate(env.sid);
    const conn = fakeConnection(env.sid);
    room.join(conn, env.member);
    await vi.advanceTimersByTimeAsync(10);
    // The leave's mutex attempt is slow; the reconnect right after it must still be written after.
    env.slow.next = true;
    room.leave(conn);
    env.registry.getOrCreate(env.sid).join(fakeConnection(env.sid), env.member);
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS * 2);
    expect(env.expires()).toHaveLength(0);
  });

  it('only the latest departure grace frees the locks (an earlier timer finds a newer mark)', async () => {
    const env = await setup();
    const room = env.registry.getOrCreate(env.sid);
    const one = fakeConnection(env.sid);
    room.join(one, env.member);
    await vi.advanceTimersByTimeAsync(10);
    room.leave(one);
    await vi.advanceTimersByTimeAsync(2_000);
    const two = fakeConnection(env.sid);
    env.registry.getOrCreate(env.sid).join(two, env.member);
    await vi.advanceTimersByTimeAsync(7_000);
    env.registry.getOrCreate(env.sid).leave(two);
    // The first departure's grace would have ended here; the second's has 9 s to go.
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS - 200);
    expect(env.expires()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(env.expires()).toHaveLength(3);
  });

  it('a rejoin on another node whose first writes fail is retried, so the grace frees nothing', async () => {
    const env = await setup();
    // A second relay node over the same Redis (its own rooms and node name).
    const other = { ...env.ctx } as RelayContext;
    await relayModule.register(other);
    const conn = fakeConnection(env.sid);
    env.registry.getOrCreate(env.sid).join(conn, env.member);
    await vi.advanceTimersByTimeAsync(10);
    env.registry.getOrCreate(env.sid).leave(conn);
    await vi.advanceTimersByTimeAsync(1_000);
    env.slow.fail = 2;
    roomsFor(other).registry.getOrCreate(env.sid).join(fakeConnection(env.sid), env.member);
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS * 2);
    expect(env.slow.fail).toBe(0);
    expect(env.expires()).toHaveLength(0);
  });

  it('after shutdown begins, a leave starts no grace timer', async () => {
    const env = await setup();
    const conn = fakeConnection(env.sid);
    env.registry.getOrCreate(env.sid).join(conn, env.member);
    await vi.advanceTimersByTimeAsync(10);
    await env.shutdown[0]?.();
    env.registry.getOrCreate(env.sid).leave(conn);
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS * 2);
    expect(env.expires()).toHaveLength(0);
  });

  it('a leave already on its way to Redis when shutdown begins starts no grace timer', async () => {
    const env = await setup();
    const conn = fakeConnection(env.sid);
    env.registry.getOrCreate(env.sid).join(conn, env.member);
    await vi.advanceTimersByTimeAsync(10);
    env.slow.next = true;
    env.registry.getOrCreate(env.sid).leave(conn);
    await vi.advanceTimersByTimeAsync(5);
    await env.shutdown[0]?.();
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS * 2);
    expect(env.expires()).toHaveLength(0);
  });
});
