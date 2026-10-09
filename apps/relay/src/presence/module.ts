/**
 * The presence relay module (B047, order 35, STAGE_ORDER.presence): the presence stage, the
 * service (`ctx.presence`) and its parts:
 *
 * - **Store:** `presence:{sid}` hashes on the relay's own Redis connection (REDIS_URL, the
 *   environment's key prefix; it connects on first use), falling back to node-local memory when
 *   Redis fails.
 * - **Online/offline:** from B043's room joins and leaves.
 * - **Other nodes:** frames go out through B045's ephemeral channel (`ctx.cluster`, which registers
 *   later and is looked up when needed), and those of other nodes come in through `receiveRemote`
 *   (the cluster module hands them over).
 * - **Snapshot:** the handshake module calls `welcomed` after each welcome.
 *
 * Settings: RELAY_PRESENCE_IN_MS, RELAY_PRESENCE_OUT_MS, RELAY_OFFLINE_GRACE_MS (`config.ts`).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { newId } from '@centcom/contracts';
import { baseConfig, keyPrefixFor, type Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { createSeqRedisClient } from '../seq/redis-store.js';
import { loadPresenceConfig } from './config.js';
import { createPresence } from './service.js';
import { presenceStage } from './stage.js';
import { createMemoryPresenceStore, createRedisPresenceStore, withFallback } from './store.js';

/** The module, reading its settings from `env` (default: the process environment). */
export function createPresenceModule(env?: Env): RelayModule {
  return {
    name: 'presence',
    order: STAGE_ORDER.presence,
    register(ctx) {
      const config = loadPresenceConfig(env);
      const base = baseConfig(env);
      const client = createSeqRedisClient({
        url: base.redisUrl,
        keyPrefix: keyPrefixFor(base.nodeEnv),
        logger: ctx.log,
      });
      const store = withFallback(
        createRedisPresenceStore(client, ctx.clock),
        createMemoryPresenceStore(ctx.clock),
        { logger: ctx.log, metrics: ctx.metrics },
      );
      // Without the cluster this node needs its own id for the entries it writes.
      const localId = newId('req').slice(4);
      const rooms = roomsFor(ctx).registry;
      const presence = createPresence({
        store,
        rooms,
        config,
        nodeId: () => ctx.cluster?.nodeId ?? localId,
        publish: (sid, frame) => void ctx.cluster?.publishEphemeral(sid, frame),
        clock: ctx.clock,
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      rooms.listen({
        joined: (room, _conn, member) => presence.onConnect(room.sid, member.id),
        left: (room, _conn, member) => presence.onDisconnect(room.sid, member.id),
      });
      ctx.pipeline.use(
        STAGE_ORDER.presence,
        presenceStage({ service: presence, clock: ctx.clock, metrics: ctx.metrics }),
      );
      ctx.presence = presence;
      ctx.onShutdown(() => {
        presence.stop();
        client.disconnect();
        return Promise.resolve();
      });
      return undefined;
    },
  };
}

const relayModule: RelayModule = createPresenceModule();

export default relayModule;
