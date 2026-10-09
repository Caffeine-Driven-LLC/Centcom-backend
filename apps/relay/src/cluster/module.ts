/**
 * The cluster relay module (B045, order 60): joins this node to the others sharing its Redis.
 * Fan-out's `RemoteDispatcher` becomes the `ClusterDispatcher` (local frames are published, the
 * other nodes' frames are reordered into the local delivery), the rooms' joins and leaves drive
 * the session and member subscriptions, and `ctx.cluster` offers `memberControl` (B051's kick),
 * `publishEphemeral` (B047's presence) and the handshake's cross-node supersede (`welcomed`).
 * Settings come from RELAY_NODE_ID, RELAY_CLUSTER_GAP_MS, RELAY_UNSUB_GRACE_MS and
 * RELAY_CLUSTER_RECONCILE_MS (`config.ts`). On shutdown it leaves every channel and deletes its
 * heartbeat.
 *
 * A relay without fan-out (no `ctx.fanout`) has nothing to route: the module registers nothing and
 * says so in the log.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { roomsFor } from '../rooms/runtime.js';
import { loadClusterConfig } from './config.js';
import { createClusterNode } from './node.js';

/** The module's registration order: after fan-out (50). */
export const CLUSTER_ORDER = 60;

/** The module, reading its settings from `env` (default: the process environment). */
export function createClusterModule(env?: Env): RelayModule {
  return {
    name: 'cluster',
    order: CLUSTER_ORDER,
    register(ctx) {
      if (ctx.fanout === undefined || ctx.seq === undefined) {
        ctx.log.warn({}, 'relay.cluster_without_fanout');
        return undefined;
      }
      const config = loadClusterConfig(env);
      const node = createClusterNode({
        pubsub: ctx.redis.pubsub,
        kv: ctx.redis.kv,
        rooms: roomsFor(ctx).registry,
        fanout: ctx.fanout,
        store: ctx.seq.store,
        config,
        clock: ctx.clock,
        onEphemeral: (sid, text) => {
          if (ctx.presence === undefined) return false;
          ctx.presence.receiveRemote(sid, text);
          return true;
        },
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.cluster = node;
      ctx.log.info({ node: config.nodeId }, 'relay.cluster_joined');
      ctx.onShutdown(() => node.stop());
      return undefined;
    },
  };
}

const relayModule: RelayModule = createClusterModule();

export default relayModule;
