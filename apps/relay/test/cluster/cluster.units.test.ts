/**
 * The cluster's parts and the seams it adds to earlier lanes (B045): message parsing and command
 * checks (`channels.ts`), settings (`config.ts`), the module's wiring (order 60, `ctx.cluster`,
 * fan-out's RemoteDispatcher); B044's release `prime`, `pin` and `setGapAfterMs`; B043's room
 * `listen`; B038's `deviceId` and `onWelcomed`; B042's priming of the release at the head.
 */
import { newId } from '@centcom/contracts';
import { ConfigError, createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  checkCommand,
  controlChannel,
  ephemeralChannel,
  framesChannel,
  nodeKey,
  parseControlMessage,
  parseEphemeralMessage,
  parseFrameMessage,
} from '../../src/cluster/channels.js';
import {
  DEFAULT_CLUSTER_GAP_MS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_UNSUB_GRACE_MS,
  loadClusterConfig,
} from '../../src/cluster/config.js';
import relayModule, { CLUSTER_ORDER, createClusterModule } from '../../src/cluster/module.js';
import { ClusterDispatcher } from '../../src/cluster/dispatcher.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createOrderedRelease } from '../../src/fanout/release.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline } from '../../src/pipeline.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { manualTimers, textConnection } from '../fanout/helpers.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { resumeUnit } from '../resume/helpers.js';
import { LIMITS, reaction } from '../seq/helpers.js';

const frameOf = (sid: string, seq: number): StoredFrame =>
  withSeq(
    stampFrame(
      { t: 'event', id: newId('msg'), k: 'reaction', p: reaction() },
      newId('mem'),
      'ts',
      sid,
    ),
    seq,
  );

describe('channels', () => {
  it('names the channels and the heartbeat key', () => {
    expect(framesChannel('ses_x')).toBe('relay:ses_x:frames');
    expect(ephemeralChannel('ses_x')).toBe('relay:ses_x:eph');
    expect(controlChannel('mem_x')).toBe('relay:member:mem_x:ctl');
    expect(nodeKey('n1')).toBe('relay:node:n1');
  });

  it('parses a frame message of the session only, sequenced frames only', () => {
    const sid = newId('ses');
    const frame = frameOf(sid, 3);
    expect(parseFrameMessage(JSON.stringify({ node: 'b', sid, frame }), sid)).toEqual({
      node: 'b',
      sid,
      frame,
    });
    for (const bad of [
      'nope',
      JSON.stringify({ node: 'b', sid: newId('ses'), frame }),
      JSON.stringify({ node: 'b', sid, frame: { ...frame, sid: newId('ses') } }),
      JSON.stringify({ node: 'b', sid, frame: { ...frame, t: 'presence' } }),
      JSON.stringify({ node: 'b', sid, frame: { ...frame, seq: 0 } }),
      JSON.stringify({ node: 'b', sid, frame: { ...frame, seq: 1.5 } }),
      JSON.stringify({ node: 1, sid, frame }),
    ]) {
      expect(parseFrameMessage(bad, sid), bad).toBeNull();
    }
  });

  it('parses ephemeral messages, never sequenced ones', () => {
    const sid = newId('ses');
    const presence = { v: 1, t: 'presence', sid, k: 'presence.typing' };
    expect(parseEphemeralMessage(JSON.stringify({ node: 'b', sid, frame: presence }), sid)).toEqual(
      { node: 'b', frame: presence },
    );
    expect(
      parseEphemeralMessage(JSON.stringify({ node: 'b', sid, frame: frameOf(sid, 1) }), sid),
    ).toBeNull();
    expect(parseEphemeralMessage('{', sid)).toBeNull();
  });

  it('checks commands: close codes, bye reasons, devices, times, matching error codes', () => {
    const dev = newId('dev');
    expect(checkCommand({ code: 4409, bye: 'superseded', device: dev, before: 5 })).toEqual({
      code: 4409,
      bye: 'superseded',
      device: dev,
      before: 5,
    });
    expect(checkCommand({ code: 4403, error: 'forbidden' })).toEqual({
      code: 4403,
      error: 'forbidden',
    });
    for (const bad of [
      null,
      { code: 4999 },
      { code: '4403' },
      { code: 4409, bye: 'NO' },
      { code: 4403, device: 'dev_bad' },
      { code: 4403, before: Number.NaN },
      { code: 4403, error: 'rate_limited' },
    ]) {
      expect(checkCommand(bad), JSON.stringify(bad)).toBeNull();
    }
    const mid = newId('mem');
    expect(
      parseControlMessage(JSON.stringify({ node: 'a', mid, cmd: { code: 4403 } }), mid),
    ).toEqual({ node: 'a', mid, cmd: { code: 4403 } });
    expect(
      parseControlMessage(
        JSON.stringify({ node: 'a', mid: newId('mem'), cmd: { code: 4403 } }),
        mid,
      ),
    ).toBeNull();
  });
});

describe('loadClusterConfig', () => {
  it("has the card's defaults and a random node id", () => {
    const a = loadClusterConfig({});
    const b = loadClusterConfig({});
    expect(a).toMatchObject({
      gapMs: DEFAULT_CLUSTER_GAP_MS,
      unsubGraceMs: DEFAULT_UNSUB_GRACE_MS,
      reconcileMs: DEFAULT_RECONCILE_MS,
    });
    expect([DEFAULT_CLUSTER_GAP_MS, DEFAULT_UNSUB_GRACE_MS]).toEqual([250, 30_000]);
    expect(a.nodeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(loadClusterConfig({ RELAY_NODE_ID: 'relay-eu-1' }).nodeId).toBe('relay-eu-1');
  });

  it('refuses bad values', () => {
    for (const bad of [
      { RELAY_NODE_ID: 'has space' },
      { RELAY_CLUSTER_GAP_MS: '5' },
      { RELAY_UNSUB_GRACE_MS: '-1' },
      { RELAY_CLUSTER_RECONCILE_MS: '600001' },
    ]) {
      expect(() => loadClusterConfig(bad), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });
});

describe('cluster/module.ts', () => {
  function context(withFanOut: boolean) {
    const pipeline = new FramePipeline();
    const steps: (() => Promise<void>)[] = [];
    const log = captureLogger();
    const store = createMemorySeqStore(LIMITS);
    const release = createOrderedRelease({ release: () => undefined });
    let dispatcher: unknown;
    const ctx = {
      log: log.logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline,
      onShutdown: (fn: () => Promise<void>) => void steps.push(fn),
      onConnection: () => undefined,
      ...(withFanOut
        ? {
            seq: { store },
            fanout: { release, setRemoteDispatcher: (d: unknown) => void (dispatcher = d) },
          }
        : {}),
    } as unknown as RelayContext;
    return { ctx, steps, log, dispatcher: () => dispatcher };
  }

  it('is the module at order 60; sets ctx.cluster and the RemoteDispatcher; leaves on shutdown', async () => {
    expect(relayModule).toMatchObject({ name: 'cluster', order: 60 });
    expect(CLUSTER_ORDER).toBe(60);
    const r = context(true);
    await createClusterModule({ RELAY_NODE_ID: 'n1' }).register(r.ctx);
    expect(r.ctx.cluster?.nodeId).toBe('n1');
    expect(r.dispatcher()).toBeInstanceOf(ClusterDispatcher);
    expect(r.steps).toHaveLength(1);
    expect(await r.ctx.redis.kv.get(nodeKey('n1'))).not.toBeNull();
    await r.steps[0]?.();
    expect(await r.ctx.redis.kv.get(nodeKey('n1'))).toBeNull();
  });

  it('registers nothing without fan-out, and says so', async () => {
    const r = context(false);
    await createClusterModule({}).register(r.ctx);
    expect(r.ctx.cluster).toBeUndefined();
    expect(r.log.lines().map((l) => l['msg'])).toContain('relay.cluster_without_fanout');
  });
});

describe('the dispatcher', () => {
  it('publishes {node, sid, frame}; counts a failed publish and rethrows', async () => {
    const sent: [string, string][] = [];
    let fail = false;
    const recorded = recordingMetrics();
    const dispatcher = new ClusterDispatcher({
      redis: {
        publish: (channel, message) =>
          fail
            ? Promise.reject(new Error('down'))
            : (sent.push([channel, message]), Promise.resolve()),
      },
      nodeId: 'me',
      release: createOrderedRelease({ release: () => undefined }),
      seq: createMemorySeqStore(LIMITS),
      metrics: recorded.metrics,
    });
    const sid = newId('ses');
    const frame = frameOf(sid, 1);
    await dispatcher.publish(sid, frame);
    expect(sent.map(([channel]) => channel)).toEqual([framesChannel(sid)]);
    const published = JSON.parse(sent[0]?.[1] ?? '{}') as Record<string, unknown>;
    expect(published).toEqual({ node: 'me', sid, at: expect.any(Number), frame });
    fail = true;
    await expect(dispatcher.publish(sid, frame)).rejects.toThrow('down');
    await expect(dispatcher.publishEphemeral(sid, { t: 'presence' })).resolves.toBeUndefined();
    expect(recorded.count('relay_cluster_publish_failed_total', { channel: 'frames' })).toBe(1);
    expect(recorded.count('relay_cluster_publish_failed_total', { channel: 'eph' })).toBe(1);
  });

  it('reconciles nothing for a session it never released, or one at the head', async () => {
    const store = createMemorySeqStore(LIMITS);
    const release = createOrderedRelease({ release: () => undefined });
    const dispatcher = new ClusterDispatcher({
      redis: { publish: () => Promise.resolve() },
      nodeId: 'me',
      release,
      seq: store,
    });
    const sid = newId('ses');
    expect(await dispatcher.reconcile(sid)).toBe(0);
    release.prime(sid, 1);
    expect(await dispatcher.reconcile(sid)).toBe(0);
  });
});

describe('seams in earlier lanes', () => {
  it('B044: prime sets where a session starts, once; pin keeps it; setGapAfterMs applies', () => {
    const released: number[] = [];
    const timers = manualTimers();
    let now = 0;
    const release = createOrderedRelease({
      release: (_sid, f) => void released.push(f.seq),
      setTimer: timers.setTimer,
      clock: () => now,
      idleMs: 10,
    });
    const sid = newId('ses');
    release.prime(sid, 5);
    release.prime(sid, 9);
    release.prime(newId('ses'), 0);
    expect(release.expected(sid)).toBe(5);
    release.offer(sid, frameOf(sid, 6));
    expect(released).toEqual([]);
    release.setGapAfterMs(40);
    release.setGapAfterMs(-1);
    release.offer(sid, frameOf(sid, 5));
    expect(released).toEqual([5, 6]);
    release.offer(sid, frameOf(sid, 9));
    expect(timers.pending.at(-1)?.ms).toBe(40);
    // A pinned session with nothing waiting survives the idle sweep (every 1 000 offers).
    const quiet = newId('ses');
    release.prime(quiet, 3);
    release.pin(quiet);
    now = 1_000;
    const other = newId('ses');
    for (let i = 1; i <= 1_000; i += 1) release.offer(other, frameOf(other, i));
    expect(release.expected(quiet)).toBe(3);
    release.unpin(quiet);
    now = 2_000;
    for (let i = 1_001; i <= 2_000; i += 1) release.offer(other, frameOf(other, i));
    expect(release.expected(quiet)).toBeNull();
  });

  it('B043: listeners hear joins and leaves after the room changed; a throwing one is skipped', () => {
    const rooms = createRoomRegistry();
    const events: string[] = [];
    rooms.listen({
      joined: () => {
        throw new Error('boom');
      },
    });
    rooms.listen({
      joined: (room, _c, m) => void events.push(`joined ${m.name} ${room.memberCount()}`),
      left: (room, _c, m) => void events.push(`left ${m.name} ${room.memberCount()}`),
    });
    const sid = newId('ses');
    const conn = textConnection(new ConnectionRegistry({ max: 10 }), sid);
    rooms.getOrCreate(sid).join(conn, {
      id: newId('mem'),
      sid,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: null,
      name: 'Ada',
      slot: 0,
    });
    rooms.get(sid)?.leave(conn);
    rooms.get(sid)?.leave(conn);
    expect(events).toEqual(['joined Ada 1', 'left Ada 0']);
  });

  it('B042: a connection’s prepare primes fan-out’s order after the head', async () => {
    const u = resumeUnit();
    await u.seed(40);
    expect(u.fanout.release.expected(u.sid)).toBeNull();
    const { conn } = await u.connect(null);
    await u.settled(conn);
    expect(u.fanout.release.expected(u.sid)).toBe(41);
  });
});
