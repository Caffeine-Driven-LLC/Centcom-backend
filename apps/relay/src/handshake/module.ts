/**
 * The handshake relay module (B038): registers the handshake stage at order 15 (STAGE_ORDER
 * .handshake) and its connection handler, which starts each connection's 5 s hello timer. Keys
 * come from RELAY_JWKS_URL, used tickets are remembered in the relay's Redis, and the live checks
 * go through `SessionAccess`: B043's Postgres implementation, from the relay's rooms
 * (`roomsFor`), whose join hook also runs before each welcome. `sys.welcome` advertises the
 * heartbeat the connection module enforces (RELAY_PING_MS, RELAY_DEAD_MS, B040) and the
 * sequencing limits the sequence module enforces (RELAY_SEQ_RATE, RELAY_SEQ_BURST, B041). B042's
 * resume (`ctx.resume`, registered later) is looked up for each hello, and B045's cluster
 * (`ctx.cluster`) supersedes the member's device on other nodes after each welcome, and B047's
 * presence (`ctx.presence`) sends the joiner its snapshot.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { loadHeartbeatConfig, welcomeHeartbeat } from '../connection/config.js';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { loadSeqConfig, welcomeSeqLimits } from '../seq/config.js';
import { loadHandshakeConfig } from './config.js';
import { createHandshake } from './handshake.js';
import { JwksCache } from './jwks.js';

const relayModule: RelayModule = {
  name: 'handshake',
  order: STAGE_ORDER.handshake,
  register(ctx) {
    const config = loadHandshakeConfig();
    const rooms = roomsFor(ctx);
    const handshake = createHandshake({
      config,
      jwks: new JwksCache({ url: config.jwksUrl, clock: ctx.clock }),
      kv: ctx.redis.kv,
      access: rooms.access,
      onAdmitted: rooms.rooms.onAdmitted,
      registry: ctx.connections,
      logger: ctx.log,
      metrics: ctx.metrics,
      clock: ctx.clock,
      heartbeat: welcomeHeartbeat(loadHeartbeatConfig()),
      seqLimits: welcomeSeqLimits(loadSeqConfig()),
      resume: () => ctx.resume,
      onWelcomed: (connection, admitted) => {
        ctx.cluster?.welcomed(connection, admitted);
        void ctx.presence?.welcomed(connection);
      },
    });
    ctx.pipeline.use(STAGE_ORDER.handshake, handshake.stage);
    ctx.onConnection(handshake.onConnection);
    return undefined;
  },
};

export default relayModule;
