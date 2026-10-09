/**
 * Test helpers for the cluster (B045):
 *
 * - `faultyRedis(inner)`: a Redis backend sharing `inner`'s key-value store and pub/sub, whose
 *   subscriptions can delay (`delayMs()`), drop (`drop(channel, message)`) or fail to subscribe
 *   (`failSubscribes`), per node: B009's in-memory pub/sub, made as lossy and unordered as Redis's;
 * - `cluster(n)`: `n` running relays (nodes) sharing one Redis, one SeqStore and one durable log,
 *   each with the codec, the handshake (rooms join, B042's resume hooks, B045's supersede), B041's
 *   sequencing, B042's resume, B044's fan-out and this lane's cluster node; `client(node)` opens a
 *   B011 SimClient on a node, `member()` makes a member whose devices connect anywhere.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type RedisBackend, type Unsubscribe } from '@centcom/core';
import { createManualClock, SimClient } from '@centcom/testkit/sim';
import codecModule from '../../src/codec/module.js';
import { createClusterNode, type ClusterNode } from '../../src/cluster/node.js';
import type { ClusterConfig } from '../../src/cluster/config.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import { createHandshake } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import type { RelayModule } from '../../src/modules.js';
import { createHydrator } from '../../src/resume/hydrate.js';
import { createResumer } from '../../src/resume/resume.js';
import { noSnapshots } from '../../src/resume/types.js';
import { createRoomRegistry, type RoomRegistry } from '../../src/rooms/registry.js';
import { createMemorySeqStore, type MemorySeqStore } from '../../src/seq/memory-store.js';
import { createSequencer } from '../../src/seq/stage.js';
import type { BufferLimits } from '../../src/seq/types.js';
import {
  memoryAccess,
  mintTicket,
  signingKey,
  stubJwks,
  TEST_HANDSHAKE_CONFIG,
  ticketFor,
  type TicketInput,
} from '../handshake/helpers.js';
import { recordingMetrics, testRelay, type TestRelay } from '../helpers.js';
import { memoryLog, type MemoryLog } from '../resume/helpers.js';
import { LIMITS } from '../seq/helpers.js';

/** One node's view of the shared Redis, with faults. */
export interface FaultyRedis extends RedisBackend {
  /** Delivery delay of each message to this node, in ms (default none). */
  delayMs: () => number;
  /** True drops the message on its way to this node. */
  drop: (channel: string, message: string) => boolean;
  /** Subscribes fail while true. */
  failSubscribes: boolean;
  /** Messages handed to this node's handlers. */
  delivered: number;
}

export function faultyRedis(inner: RedisBackend): FaultyRedis {
  const redis: FaultyRedis = {
    kv: inner.kv,
    rateLimit: inner.rateLimit,
    ping: () => inner.ping(),
    close: () => Promise.resolve(),
    delayMs: () => 0,
    drop: () => false,
    failSubscribes: false,
    delivered: 0,
    pubsub: {
      publish: (channel, message) => inner.pubsub.publish(channel, message),
      async subscribe(channel, handler): Promise<Unsubscribe> {
        if (redis.failSubscribes) throw new Error('subscribe failed');
        return inner.pubsub.subscribe(channel, (message) => {
          if (redis.drop(channel, message)) return;
          const deliver = () => {
            redis.delivered += 1;
            handler(message);
          };
          const delay = redis.delayMs();
          if (delay <= 0) deliver();
          else setTimeout(deliver, delay).unref();
        });
      },
    },
  };
  return redis;
}

/** Counters (as `recordingMetrics`) and every histogram observation. */
export function capturingMetrics() {
  const recorded = recordingMetrics();
  const observations = new Map<string, number[]>();
  return {
    ...recorded,
    metrics: {
      counter: recorded.metrics.counter,
      histogram: (name: string) => ({
        observe: (value: number) => {
          const list = observations.get(name) ?? [];
          list.push(value);
          observations.set(name, list);
        },
      }),
    },
    observed: (name: string): number[] => observations.get(name) ?? [],
  };
}

/** A relay node of the test cluster. */
export interface Node {
  name: string;
  relay: TestRelay;
  redis: FaultyRedis;
  rooms: RoomRegistry;
  cluster: () => ClusterNode;
  metrics: ReturnType<typeof capturingMetrics>;
}

/** `n` nodes sharing one Redis, one SeqStore and one durable log. */
export async function cluster(
  n: number,
  opts: {
    limits?: BufferLimits;
    config?: Partial<ClusterConfig>;
    rate?: number;
    /** Each node's own connection to one Redis (default: one shared in-memory backend). */
    backend?: () => RedisBackend;
  } = {},
) {
  const shared = createMemoryRedis();
  const backends: RedisBackend[] = [];
  const store: MemorySeqStore = createMemorySeqStore(opts.limits ?? LIMITS);
  const log: MemoryLog = memoryLog();
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  const sid = newId('ses');
  const nodes: Node[] = [];
  const clients: SimClient[] = [];

  async function startNode(name: string): Promise<Node> {
    const own = opts.backend?.();
    if (own !== undefined) backends.push(own);
    const redis = faultyRedis(own ?? shared);
    const rooms = createRoomRegistry();
    const metrics = capturingMetrics();
    let node: ClusterNode | undefined;
    const modules: RelayModule[] = [
      codecModule,
      {
        name: 'handshake',
        order: 15,
        register(ctx) {
          const handshake = createHandshake({
            config: TEST_HANDSHAKE_CONFIG,
            jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }),
            kv: ctx.redis.kv,
            access,
            registry: ctx.connections,
            onAdmitted: (conn, admitted) => {
              rooms.getOrCreate(admitted.sid).join(conn, {
                id: admitted.access.member.id,
                sid: admitted.sid,
                role: admitted.access.member.role,
                userId: newId('usr'),
                workspaceId: null,
                name: 'M',
                slot: 0,
              });
              conn.onClose(() => rooms.locate(conn)?.room.leave(conn));
              return { ok: true };
            },
            resume: () => ctx.resume,
            onWelcomed: (conn, admitted) => ctx.cluster?.welcomed(conn, admitted),
          });
          ctx.pipeline.use(15, handshake.stage);
          ctx.onConnection(handshake.onConnection);
          return undefined;
        },
      },
      {
        name: 'seq',
        order: 40,
        register(ctx) {
          const rate = opts.rate ?? 100_000;
          const sequencer = createSequencer({
            store,
            rate,
            burst: rate,
            clock: ctx.clock,
            durable: log,
          });
          ctx.pipeline.use(40, sequencer.stage);
          ctx.onConnection(sequencer.onConnection);
          ctx.seq = sequencer.service;
          return undefined;
        },
      },
      {
        name: 'resume',
        order: 45,
        register(ctx) {
          const seq = ctx.seq;
          if (seq === undefined) throw new Error('no seq');
          const hydrator = createHydrator({
            store: seq.store,
            durable: log,
            frames: 5_000,
            maxBufferFrames: LIMITS.maxFrames,
          });
          seq.setReadiness(hydrator.ready);
          const resumer = createResumer({
            store: seq.store,
            durable: log,
            snapshots: noSnapshots,
            hydrator,
            fanout: () => ctx.fanout,
            batch: 100,
            maxFrames: 50_000,
          });
          ctx.pipeline.use(45, resumer.stage);
          ctx.resume = resumer;
          return undefined;
        },
      },
      {
        name: 'fanout',
        order: 50,
        register(ctx) {
          const seq = ctx.seq;
          if (seq === undefined) throw new Error('no seq');
          const fanout = createFanOut({ rooms, seq, clock: ctx.clock, metrics: ctx.metrics });
          seq.delegateEcho((conn, frame) => fanout.sendTo(conn, frame));
          ctx.pipeline.use(50, fanout.stage);
          ctx.fanout = fanout;
          return undefined;
        },
      },
      {
        name: 'cluster',
        order: 60,
        register(ctx) {
          if (ctx.fanout === undefined || ctx.seq === undefined) throw new Error('no fan-out');
          node = createClusterNode({
            pubsub: ctx.redis.pubsub,
            kv: ctx.redis.kv,
            rooms,
            fanout: ctx.fanout,
            store: ctx.seq.store,
            config: {
              nodeId: name,
              gapMs: 250,
              unsubGraceMs: 30_000,
              reconcileMs: 5_000,
              ...opts.config,
            },
            clock: ctx.clock,
            metrics: metrics.metrics,
          });
          ctx.cluster = node;
          ctx.onShutdown(() => node?.stop() ?? Promise.resolve());
          return undefined;
        },
      },
    ];
    const relay = await testRelay({ modules, redis });
    const started: Node = {
      name,
      relay,
      redis,
      rooms,
      metrics,
      cluster: () => {
        if (node === undefined) throw new Error('the cluster module did not register');
        return node;
      },
    };
    nodes.push(started);
    return started;
  }

  for (let i = 0; i < n; i += 1) await startNode(`node-${String.fromCharCode(97 + i)}`);

  return {
    nodes,
    store,
    log,
    access,
    sid,
    shared,
    startNode,
    /** A member of the session (one ticket input, reusable for its device on any node). */
    member(overrides: Partial<TicketInput> = {}): TicketInput {
      const claims = ticketFor({ sid, ...overrides });
      access.allow(claims);
      return claims;
    },
    /** Another device of `member`, allowed in the session. */
    device(member: TicketInput): TicketInput {
      const claims = { ...member, dev: newId('dev') };
      access.allow(claims);
      return claims;
    },
    /** A SimClient for `claims` (default a new member) on `node`. */
    async client(node: Node, claims?: TicketInput, lastSeq: number | null = null) {
      const c = claims ?? this.member();
      const client = await SimClient.connect({
        url: node.relay.url,
        ticket: () => mintTicket(key, c),
        clock: createManualClock(),
        lastSeq,
      });
      clients.push(client);
      return client;
    },
    /** Opens a client to `node` reusing `claims`'s member and device, for a new ticket. */
    ticketFor: (c: TicketInput) => mintTicket(key, c),
    url: (node: Node) => node.relay.url,
    async stopNode(node: Node): Promise<void> {
      await node.cluster().stop();
      await node.relay.stop();
    },
    async stop(): Promise<void> {
      for (const c of clients) c.terminate();
      for (const node of nodes) {
        await node
          .cluster()
          .stop()
          .catch(() => undefined);
        await node.relay.stop().catch(() => undefined);
      }
      for (const backend of backends) await backend.close().catch(() => undefined);
    },
  };
}

/** Event seqs a client received, in arrival order. */
export const seqs = (c: SimClient): number[] =>
  c.wire.filter((f) => typeof f.seq === 'number').map((f) => f.seq as number);

export const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
