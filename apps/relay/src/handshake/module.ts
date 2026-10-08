/**
 * The handshake relay module (B038): registers the handshake stage at order 15 (STAGE_ORDER
 * .handshake) and its connection handler, which starts each connection's 5 s hello timer. Keys
 * come from RELAY_JWKS_URL, used tickets are remembered in the relay's Redis, and the live checks
 * go through `SessionAccess`. That port's Postgres implementation is B043's; until it is wired
 * here, every handshake fails closed with 4503. `sys.welcome` advertises the heartbeat the
 * connection module enforces (RELAY_PING_MS, RELAY_DEAD_MS, B040) and the sequencing limits the
 * sequence module enforces (RELAY_SEQ_RATE, RELAY_SEQ_BURST, B041).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { loadHeartbeatConfig, welcomeHeartbeat } from '../connection/config.js';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { loadSeqConfig, welcomeSeqLimits } from '../seq/config.js';
import { unavailableSessionAccess } from './access.js';
import { loadHandshakeConfig } from './config.js';
import { createHandshake } from './handshake.js';
import { JwksCache } from './jwks.js';

const relayModule: RelayModule = {
  name: 'handshake',
  order: STAGE_ORDER.handshake,
  register(ctx) {
    const config = loadHandshakeConfig();
    const handshake = createHandshake({
      config,
      jwks: new JwksCache({ url: config.jwksUrl, clock: ctx.clock }),
      kv: ctx.redis.kv,
      access: unavailableSessionAccess,
      registry: ctx.connections,
      logger: ctx.log,
      metrics: ctx.metrics,
      clock: ctx.clock,
      heartbeat: welcomeHeartbeat(loadHeartbeatConfig()),
      seqLimits: welcomeSeqLimits(loadSeqConfig()),
    });
    ctx.pipeline.use(STAGE_ORDER.handshake, handshake.stage);
    ctx.onConnection(handshake.onConnection);
    return undefined;
  },
};

export default relayModule;
