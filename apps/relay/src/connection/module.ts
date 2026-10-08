/**
 * The connection relay module (B040), order 12: registers the heartbeat's activity stage (order 5,
 * before decoding, so every inbound message counts), its state and ping/pong stage (order 12,
 * between decoding and the handshake) and its connection handler, which starts each connection's
 * state machine. Settings come from RELAY_PING_MS and RELAY_DEAD_MS, the same values the
 * handshake advertises in `sys.welcome`. On shutdown the wheel stops.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { loadHeartbeatConfig } from './config.js';
import { createHeartbeat } from './heartbeat.js';

const relayModule: RelayModule = {
  name: 'connection',
  order: STAGE_ORDER.heartbeat,
  register(ctx) {
    const heartbeat = createHeartbeat({
      config: loadHeartbeatConfig(),
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    ctx.pipeline.use(STAGE_ORDER.activity, heartbeat.activityStage);
    ctx.pipeline.use(STAGE_ORDER.heartbeat, heartbeat.stage);
    ctx.onConnection(heartbeat.onConnection);
    ctx.onShutdown(() => {
      heartbeat.stop();
      return Promise.resolve();
    });
    return undefined;
  },
};

export default relayModule;
