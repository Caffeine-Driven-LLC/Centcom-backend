/**
 * The fan-out relay module (B044), order 50: registers the fan-out stage (STAGE_ORDER.fanOut,
 * after sequencing), takes over the sender's echo from B041 (`ctx.seq.delegateEcho`, so each
 * connection gets frames strictly in `seq` order), and offers `ctx.fanout` to the modules after
 * it. Rooms come from B043 (`roomsFor(ctx)`). A relay without the sequence module (no `ctx.seq`)
 * has nothing to fan out: the module registers nothing and says so in the log.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { createFanOut } from './fanout.js';

const relayModule: RelayModule = {
  name: 'fanout',
  order: STAGE_ORDER.fanOut,
  register(ctx) {
    if (ctx.seq === undefined) {
      ctx.log.warn({}, 'relay.fanout_without_seq');
      return undefined;
    }
    const fanout = createFanOut({
      rooms: roomsFor(ctx).registry,
      seq: ctx.seq,
      logger: ctx.log,
      metrics: ctx.metrics,
      clock: ctx.clock,
    });
    // Resends' echoes go through fan-out too, so a connection's hold (B042) keeps them in order.
    ctx.seq.delegateEcho((conn, frame) => fanout.sendTo(conn, frame));
    ctx.pipeline.use(STAGE_ORDER.fanOut, fanout.stage);
    ctx.fanout = fanout;
    ctx.onShutdown(() => {
      fanout.stop();
      return Promise.resolve();
    });
    return undefined;
  },
};

export default relayModule;
