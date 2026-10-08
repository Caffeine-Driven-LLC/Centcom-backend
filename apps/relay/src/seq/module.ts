/**
 * The sequence relay module (B041): registers the sequence stage at order 40 (STAGE_ORDER.sequence)
 * over the Redis SeqStore, forgets each connection's state when it closes, and offers `ctx.seq`
 * (the store, the ack tracker and the DurableAppend port) to the modules registered after it.
 * Settings come from RELAY_SEQ_* and RELAY_BUF_* (`config.ts`); the Redis connection from
 * REDIS_URL under the environment's key prefix. Nothing here waits for Redis: the connection opens
 * with the first sequenced frame and is closed on shutdown.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { baseConfig, keyPrefixFor, type Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { loadSeqConfig } from './config.js';
import { createRedisSeqStore, createSeqRedisClient } from './redis-store.js';
import { createSequencer } from './stage.js';

/** The module, reading its settings from `env` (default: the process environment). */
export function createSeqModule(env?: Env): RelayModule {
  return {
    name: 'seq',
    order: STAGE_ORDER.sequence,
    register(ctx) {
      const config = loadSeqConfig(env);
      const base = baseConfig(env);
      const client = createSeqRedisClient({
        url: base.redisUrl,
        keyPrefix: keyPrefixFor(base.nodeEnv),
        logger: ctx.log,
      });
      const sequencer = createSequencer({
        store: createRedisSeqStore(client, config.buffer),
        rate: config.rate,
        burst: config.burst,
        clock: ctx.clock,
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.pipeline.use(STAGE_ORDER.sequence, sequencer.stage);
      ctx.onConnection(sequencer.onConnection);
      ctx.seq = sequencer.service;
      ctx.onShutdown(() => {
        sequencer.stop();
        client.disconnect();
        return Promise.resolve();
      });
      return undefined;
    },
  };
}

const relayModule: RelayModule = createSeqModule();

export default relayModule;
