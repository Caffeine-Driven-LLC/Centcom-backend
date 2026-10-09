/**
 * The rooms relay module (B043), order 20: registers the authorise stage (STAGE_ORDER.authorise,
 * after the handshake) and subscribes to `centcom:membership`. The handshake module takes the same
 * rooms' `SessionAccess` and join hook through `roomsFor(ctx)`. On shutdown the subscription
 * stops and queued audit events are written (5 s at most).
 *
 * Owns: wiring. Must not: hold state outside what `roomsFor` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from './runtime.js';

/** How long shutdown waits for queued audit events. */
export const AUDIT_FLUSH_MS = 5_000;

const relayModule: RelayModule = {
  name: 'rooms',
  order: STAGE_ORDER.authorise,
  register(ctx) {
    const { rooms, audit } = roomsFor(ctx);
    ctx.pipeline.use(STAGE_ORDER.authorise, rooms.stage);
    const listener = rooms.listen(ctx.redis.pubsub);
    ctx.onShutdown(async () => {
      await listener.stop();
      await audit.flush(AUDIT_FLUSH_MS);
    });
    return undefined;
  },
};

export default relayModule;
