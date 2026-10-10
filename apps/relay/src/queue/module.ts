/**
 * The queue relay module (B052, order 39 = STAGE_ORDER.queue): the queue stage, the host-loss
 * listener on the rooms, and `ctx.queue` (the service: `lastState` for the handshake's joiners,
 * `onHostChanged` for B051, `setApprovalsPaused` for B076).
 *
 * - **Store:** Postgres (`queue_session`, `queue_item`), locked per session.
 * - **Policy:** B051's `ctx.control.policies` (the defaults on a relay without it).
 * - **Sequencing:** B044's `emitServer` and `sendTo`, B041's buffer for catch-up; looked up when
 *   needed (their modules register later).
 * - **Host loss:** the rooms tell this node when the host's last connection here closes (items
 *   held) and when the host joins (items back).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { DEFAULT_POLICY } from '../control/policy-store.js';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import type { StoredFrame } from '../seq/types.js';
import { createQueueService } from './service.js';
import { queueStage } from './stage.js';
import { createPostgresQueueStore, type QueueDb } from './store.js';

/** Frames read from B041's buffer per call during catch-up. */
const RANGE_BATCH = 1_000;

const relayModule: RelayModule = {
  name: 'queue',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const service = createQueueService({
      // The relay's client reaches every table; the queue tables are typed in @centcom/db.
      store: createPostgresQueueStore(ctx.db as unknown as QueueDb),
      policies: {
        get: (sid) => ctx.control?.policies.get(sid) ?? Promise.resolve({ ...DEFAULT_POLICY }),
      },
      sequencer: {
        async emitState(sid, body) {
          const fanout = ctx.fanout;
          if (fanout === undefined) throw new Error('queue: the relay has no fan-out');
          return fanout.emitServer(sid, 'queue.state', 'queue', { ...body });
        },
        async framesAfter(sid, afterSeq) {
          const store = ctx.seq?.store;
          if (store === undefined) return [];
          const frames: StoredFrame[] = [];
          let cursor = afterSeq;
          for (;;) {
            const batch = await store.range(sid, cursor, RANGE_BATCH);
            frames.push(...batch);
            const last = batch.at(-1);
            if (batch.length < RANGE_BATCH || last === undefined) break;
            cursor = last.seq;
          }
          return frames;
        },
        async resend(conn, sid, seq) {
          const [frame] = (await ctx.seq?.store.range(sid, seq - 1, 1)) ?? [];
          if (frame === undefined || frame.seq !== seq || ctx.fanout === undefined) return false;
          ctx.fanout.sendTo(conn, frame);
          return true;
        },
      },
      audit: rooms.audit,
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    rooms.registry.listen({
      joined(room, _conn, member) {
        if (member.role === 'host') void service.onHostReconnected(room.sid);
      },
      left(room, _conn, member) {
        if (member.role === 'host' && !room.hasMember(member.id)) {
          void service.onHostDisconnected(room.sid);
        }
      },
    });
    ctx.pipeline.use(STAGE_ORDER.queue, queueStage({ service, rooms: rooms.registry }));
    ctx.queue = service;
    return undefined;
  },
};

export default relayModule;
