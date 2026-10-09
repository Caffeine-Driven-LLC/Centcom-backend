/**
 * The keys relay module (B049, order 25 = STAGE_ORDER.keys): the validation stage at 25 and the
 * rotation stage at 41 (STAGE_ORDER.rotate, right after sequencing), and `ctx.epoch` (the tracker,
 * the signal B051's kick calls, and `due`).
 *
 * - **Epoch store:** Redis `relay:ses:{sid}:epoch` on the relay's own connection (REDIS_URL, the
 *   environment's key prefix; it connects on first use).
 * - **Device check:** Postgres.
 * - B041's ack tracker and B044's fan-out are looked up when needed: their modules register later.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { baseConfig, keyPrefixFor, type Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { createSeqRedisClient } from '../seq/redis-store.js';
import { createPostgresSessionDevices } from './devices.js';
import { createRedisEpochStore } from './epoch-store.js';
import { createEpochs } from './epochs.js';
import { keysStage, rotateStage } from './stage.js';

/** The module, reading REDIS_URL from `env` (default: the process environment). */
export function createKeysModule(env?: Env): RelayModule {
  return {
    name: 'keys',
    order: STAGE_ORDER.keys,
    register(ctx) {
      const base = baseConfig(env);
      const client = createSeqRedisClient({
        url: base.redisUrl,
        keyPrefix: keyPrefixFor(base.nodeEnv),
        logger: ctx.log,
      });
      const epochs = createEpochs({
        store: createRedisEpochStore(client),
        seq: { head: (sid) => ctx.seq?.store.head(sid) ?? Promise.resolve(0) },
        fanout: () => ctx.fanout,
        clock: ctx.clock,
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.pipeline.use(
        STAGE_ORDER.keys,
        keysStage({
          epochs,
          devices: createPostgresSessionDevices(ctx.db, ctx.clock),
          rooms: roomsFor(ctx).registry,
          acks: () => ctx.seq?.acks,
          metrics: ctx.metrics,
        }),
      );
      ctx.pipeline.use(
        STAGE_ORDER.rotate,
        rotateStage({ epochs, logger: ctx.log, metrics: ctx.metrics }),
      );
      ctx.epoch = epochs;
      ctx.onShutdown(() => {
        client.disconnect();
        return Promise.resolve();
      });
      return undefined;
    },
  };
}

const relayModule: RelayModule = createKeysModule();

export default relayModule;
