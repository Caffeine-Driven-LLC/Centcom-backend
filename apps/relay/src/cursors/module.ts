/**
 * The cursors relay module (B048, order 36, STAGE_ORDER.cursors): the cursor stage and throttle
 * (100 ms tick, published to other nodes through B045's ephemeral channel, `ctx.cluster`, looked
 * up when needed), and typing auto-clear over B047's presence (`ctx.presence.onUpdate`). A member
 * leaving the session here (B043's leave, its last connection in the room) loses its cursor slot
 * and its typing timer. Settings: RELAY_CURSOR_IN_PER_S, RELAY_CURSOR_TICK_MS, RELAY_TYPING_TTL_MS,
 * RELAY_CURSOR_MAX_CT_BYTES (`config.ts`).
 *
 * Without presence (no `ctx.presence`) typing is not tracked, and the log says so.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { loadCursorsConfig } from './config.js';
import { cursorStage } from './stage.js';
import { createCursorThrottle } from './throttle.js';
import { createTypingTracker } from './typing.js';

/** The module, reading its settings from `env` (default: the process environment). */
export function createCursorsModule(env?: Env): RelayModule {
  return {
    name: 'cursors',
    order: STAGE_ORDER.cursors,
    register(ctx) {
      const config = loadCursorsConfig(env);
      const rooms = roomsFor(ctx).registry;
      const throttle = createCursorThrottle({
        rooms,
        config,
        publish: (sid, frame) => void ctx.cluster?.publishEphemeral(sid, frame),
        clock: ctx.clock,
        metrics: ctx.metrics,
      });
      ctx.pipeline.use(STAGE_ORDER.cursors, cursorStage({ throttle, clock: ctx.clock }));
      const presence = ctx.presence;
      const typing =
        presence === undefined
          ? undefined
          : createTypingTracker({
              presence,
              ttlMs: config.typingTtlMs,
              clock: ctx.clock,
              metrics: ctx.metrics,
            });
      if (presence === undefined || typing === undefined) {
        ctx.log.warn({}, 'relay.cursors_without_presence');
      } else {
        presence.onUpdate((sid, mid, p, nowMs) => typing.observe(sid, mid, p, nowMs));
      }
      rooms.listen({
        left(room, _conn, member) {
          if (room.hasMember(member.id)) return;
          throttle.forget(room.sid, member.id);
          typing?.clear(room.sid, member.id);
        },
      });
      ctx.onShutdown(() => {
        throttle.stop();
        typing?.stop();
        return Promise.resolve();
      });
      return undefined;
    },
  };
}

const relayModule: RelayModule = createCursorsModule();

export default relayModule;
