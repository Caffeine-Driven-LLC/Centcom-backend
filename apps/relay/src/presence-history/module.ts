/**
 * The presence history relay module (B067, order 35 = STAGE_ORDER.presence, beside B047's presence
 * stage): records when members come online and go offline, and when they were last seen, and sets
 * `ctx.presenceHistory` (the lookups for other backend lanes; never a route).
 *
 * - **Online/offline:** this node's room joins and leaves (B043), with B047's offline grace
 *   (RELAY_OFFLINE_GRACE_MS); a connection's close code (captured as it closes) gives the reason.
 * - **Last seen:** the stage touches the sender of every frame that reaches it; every
 *   TOUCH_EVERY_MS (60 s) the module touches every member connected here; the recorder writes a
 *   connection at most once a minute either way.
 * - **Store:** Postgres (`presence_log`, `member_last_seen`); flushed every second, and at
 *   shutdown.
 * - **Retention:** `ctx.presenceHistory.purgeOlderThan` (30 days), scheduled by B090.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { Env } from '@centcom/core';
import type { ConnectionEntry } from '../connection-registry.js';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { loadPresenceConfig } from '../presence/config.js';
import { roomsFor } from '../rooms/runtime.js';
import { TOUCH_EVERY_MS } from './ports.js';
import {
  createPostgresHistoryWriter,
  createPostgresPresenceHistory,
  type PresenceHistoryDb,
} from './queries.js';
import { createConnectionEvents, PresenceHistoryRecorder } from './recorder.js';

/** The module, reading B047's offline grace from `env` (default: the process environment). */
export function createPresenceHistoryModule(env?: Env): RelayModule {
  return {
    name: 'presence-history',
    order: STAGE_ORDER.presence,
    register(ctx) {
      const rooms = roomsFor(ctx).registry;
      const db = ctx.db as unknown as PresenceHistoryDb;
      const recorder = new PresenceHistoryRecorder({
        writer: createPostgresHistoryWriter(db),
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      const events = createConnectionEvents({
        recorder,
        graceMs: loadPresenceConfig(env).offlineGraceMs,
        clock: ctx.clock,
      });
      /** Each connection's close code, as it closes. */
      const codes = new WeakMap<ConnectionEntry, number>();
      rooms.listen({
        joined(room, conn, member) {
          conn.onClose((code) => codes.set(conn.entry, code));
          events.joined(room.sid, member.id, conn.entry.deviceId);
        },
        left(room, conn, member) {
          if (room.hasMember(member.id)) return;
          events.left(room.sid, member.id, conn.entry.deviceId, () => codes.get(conn.entry));
        },
      });
      const touch = (sid: string, memberId: string, deviceId: string | null) =>
        recorder.touch({ sid, memberId, deviceId, at: new Date(ctx.clock()) });
      ctx.pipeline.use(STAGE_ORDER.presence, (fc, next) => {
        const where = rooms.locate(fc.connection);
        if (where !== undefined)
          touch(where.room.sid, where.member.id, fc.connection.entry.deviceId);
        return next();
      });
      const sweep = setInterval(() => {
        for (const room of rooms.rooms()) {
          for (const conn of room.connections()) {
            const where = rooms.locate(conn);
            if (where !== undefined) touch(room.sid, where.member.id, conn.entry.deviceId);
          }
        }
      }, TOUCH_EVERY_MS);
      sweep.unref();
      ctx.onShutdown(async () => {
        clearInterval(sweep);
        events.stop();
        await recorder.flush();
      });
      ctx.presenceHistory = createPostgresPresenceHistory(db, ctx.clock);
      return undefined;
    },
  };
}

const relayModule: RelayModule = createPresenceHistoryModule();

export default relayModule;
