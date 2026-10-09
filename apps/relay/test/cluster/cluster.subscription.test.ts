/**
 * Subscriptions (B045; tests "cluster.subscription.test.ts", acceptance 5, guardrails "subscribe
 * only after authorisation" and "ephemeral frames never feed the buffer", failure mode "pub/sub
 * connection drops"): a node subscribes to a session's channels when the session's room gets its
 * first local connection (B043's join, after the handshake authorised it), and to a member's
 * control channel while the member has one; it leaves them RELAY_UNSUB_GRACE_MS (30 s) after the
 * last one left, unless someone joined again, and then receives nothing for the session. A
 * failed subscribe is retried with backoff and the session reconciled once it holds. Ephemeral
 * frames reach local connections only. The heartbeat key lives 15 s and goes on stop.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { ephemeralChannel, framesChannel, nodeKey } from '../../src/cluster/channels.js';
import { createClusterNode } from '../../src/cluster/node.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { manualTimers, textConnection, type TextConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';
import { LIMITS, reaction } from '../seq/helpers.js';
import { faultyRedis } from './helpers.js';

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function nodeUnit(opts: { reconcileMs?: number } = {}) {
  const shared = createMemoryRedis();
  const redis = faultyRedis(shared);
  const rooms = createRoomRegistry();
  const store = createMemorySeqStore(LIMITS);
  const timers = manualTimers();
  const fanout = createFanOut({
    rooms,
    seq: { store, submitServer: () => Promise.reject(new Error('unused')) },
    setTimer: timers.setTimer,
  });
  const recorded = recordingMetrics();
  const node = createClusterNode({
    pubsub: redis.pubsub,
    kv: redis.kv,
    rooms,
    fanout,
    store,
    config: {
      nodeId: 'node-a',
      gapMs: 250,
      unsubGraceMs: 30_000,
      reconcileMs: opts.reconcileMs ?? 5_000,
    },
    setTimer: timers.setTimer,
    random: () => 0.5,
    metrics: recorded.metrics,
  });
  const registry = new ConnectionRegistry({ max: 100 });
  const sid = newId('ses');
  function join(member = newId('mem'), session = sid): TextConnection {
    const conn = textConnection(registry, session, member);
    rooms.getOrCreate(session).join(conn, {
      id: member,
      sid: session,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    return conn;
  }
  const leave = (conn: TextConnection) => rooms.locate(conn)?.room.leave(conn);
  /** A frame of `sid` published by another node. */
  async function remote(seq: number, session = sid): Promise<void> {
    const from = newId('mem');
    const id = newId('msg');
    const frame = stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'ts', session);
    await store.assign(session, { from, id }, frame, 0);
    await shared.pubsub.publish(
      framesChannel(session),
      JSON.stringify({ node: 'node-b', sid: session, frame: withSeq(frame, seq) }),
    );
  }
  const received = () =>
    recorded.count('relay_cluster_received_total', { channel: 'frames', result: 'offered' });
  return {
    shared,
    redis,
    rooms,
    store,
    timers,
    fanout,
    node,
    sid,
    join,
    leave,
    remote,
    received,
    recorded,
  };
}

describe('session subscriptions (acceptance 5)', () => {
  it('subscribes on the first local join and only then receives', async () => {
    const u = nodeUnit();
    await u.remote(1);
    expect(u.received()).toBe(0);
    expect(u.node.sessions()).toEqual([]);
    const conn = u.join();
    await turn();
    expect(u.node.sessions()).toEqual([u.sid]);
    u.fanout.release.prime(u.sid, 2);
    await u.remote(2);
    expect(u.received()).toBe(1);
    expect(conn.seqs()).toEqual([2]);
  });

  it('leaves 30 s after the last connection left; nothing is received after', async () => {
    const u = nodeUnit();
    const a = u.join();
    const b = u.join();
    await turn();
    u.leave(a);
    u.timers.fire();
    await turn();
    expect(u.node.sessions()).toEqual([u.sid]);
    u.leave(b);
    const grace = u.timers.pending.filter((t) => t.ms === 30_000);
    expect(grace.length).toBeGreaterThan(0);
    // Still subscribed during the grace.
    await u.remote(1);
    expect(u.received()).toBe(1);
    u.timers.fire();
    await turn();
    expect(u.node.sessions()).toEqual([]);
    await u.remote(2);
    await u.remote(3);
    expect(u.received()).toBe(1);
    expect(
      u.recorded.count('relay_cluster_subscriptions_total', {
        kind: 'session',
        op: 'unsubscribed',
      }),
    ).toBe(1);
  });

  it('a join during the grace keeps the subscription', async () => {
    const u = nodeUnit();
    const a = u.join();
    await turn();
    u.leave(a);
    u.join();
    u.timers.fire();
    await turn();
    expect(u.node.sessions()).toEqual([u.sid]);
    expect(
      u.recorded.count('relay_cluster_subscriptions_total', { kind: 'session', op: 'subscribed' }),
    ).toBe(1);
  });

  it('subscribes to a member’s control channel while it has a connection here', async () => {
    const u = nodeUnit();
    const member = newId('mem');
    const one = u.join(member);
    const other = u.join(member, newId('ses'));
    await turn();
    expect(u.node.members()).toEqual([member]);
    u.leave(one);
    u.timers.fire();
    await turn();
    expect(u.node.members()).toEqual([member]);
    u.leave(other);
    u.timers.fire();
    await turn();
    expect(u.node.members()).toEqual([]);
  });
});

describe('when subscribing fails', () => {
  it('retries with backoff, then reconciles the frames published meanwhile', async () => {
    const u = nodeUnit();
    u.redis.failSubscribes = true;
    const conn = u.join();
    await turn();
    expect(u.node.sessions()).toEqual([]);
    expect(
      u.recorded.count('relay_cluster_subscriptions_total', { kind: 'session', op: 'failed' }),
    ).toBeGreaterThan(0);
    u.fanout.release.prime(u.sid, 1);
    await u.remote(1);
    await u.remote(2);
    expect(conn.seqs()).toEqual([]);
    const retry = u.timers.pending.find((t) => t.ms < 1_000);
    expect(retry?.ms).toBe(150);
    u.redis.failSubscribes = false;
    u.timers.fire();
    for (let i = 0; i < 5; i += 1) await turn();
    expect(u.node.sessions()).toContain(u.sid);
    expect(conn.seqs()).toEqual([1, 2]);
  });
});

describe('ephemeral frames', () => {
  it('reach local connections only: not the release, the buffer or the log', async () => {
    const u = nodeUnit();
    const conn = u.join();
    await turn();
    const presence = {
      v: 1,
      t: 'presence',
      sid: u.sid,
      from: newId('mem'),
      k: 'presence.typing',
      p: { on: true },
    };
    await u.shared.pubsub.publish(
      ephemeralChannel(u.sid),
      JSON.stringify({ node: 'node-b', sid: u.sid, frame: presence }),
    );
    // A sequenced type on the ephemeral channel is refused.
    await u.shared.pubsub.publish(
      ephemeralChannel(u.sid),
      JSON.stringify({ node: 'node-b', sid: u.sid, frame: { ...presence, t: 'event', seq: 1 } }),
    );
    expect(conn.frames()).toEqual([presence]);
    expect(u.fanout.release.expected(u.sid)).toBeNull();
    expect(await u.store.head(u.sid)).toBe(0);
    let published = '';
    await u.shared.pubsub.subscribe(ephemeralChannel(u.sid), (m) => void (published = m));
    await u.node.publishEphemeral(u.sid, presence);
    expect(JSON.parse(published)).toEqual({ node: 'node-a', sid: u.sid, frame: presence });
  });
});

describe('heartbeat and stop', () => {
  it('keeps relay:node:{id} for 15 s, refreshed; stop leaves everything and deletes it', async () => {
    const u = nodeUnit();
    u.join();
    await turn();
    const raw = await u.shared.kv.get(nodeKey('node-a'));
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ node: 'node-a' });
    const ttl = (await u.shared.kv.ttl(nodeKey('node-a'))) ?? 0;
    expect(ttl).toBeGreaterThan(10_000);
    expect(ttl).toBeLessThanOrEqual(15_000);
    expect(u.timers.pending.some((t) => t.ms === 5_000)).toBe(true);
    await u.node.stop();
    expect(await u.shared.kv.get(nodeKey('node-a'))).toBeNull();
    expect(u.node.sessions()).toEqual([]);
    await u.remote(1);
    expect(u.received()).toBe(0);
  });

  it('sweeps subscribed sessions against the head every RELAY_CLUSTER_RECONCILE_MS', async () => {
    const u = nodeUnit({ reconcileMs: 1_000 });
    const conn = u.join();
    await turn();
    u.fanout.release.prime(u.sid, 1);
    // Two frames sequenced elsewhere whose messages never came.
    for (let i = 0; i < 2; i += 1) {
      const from = newId('mem');
      const id = newId('msg');
      await u.store.assign(
        u.sid,
        { from, id },
        stampFrame({ t: 'event', id, k: 'reaction', p: reaction() }, from, 'ts', u.sid),
        0,
      );
    }
    expect(u.timers.pending.some((t) => t.ms === 1_000)).toBe(true);
    u.timers.fire();
    for (let i = 0; i < 3; i += 1) await turn();
    expect(conn.seqs()).toEqual([1, 2]);
  });
});
