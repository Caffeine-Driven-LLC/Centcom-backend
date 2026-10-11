/**
 * The locks relay module (B059, order 39 = STAGE_ORDER.queue, beside B052's and B057's stages):
 * the locks stage, the expiry sweep (every LOCK_SWEEP_MS) over every session with a member on this
 * node (a restarted node keeps sweeping a session's locks as soon as a member joins), member
 * leaves (which nodes a member is connected on is kept with the session's locks; a member gone
 * from every node for LEAVE_GRACE_MS loses its locks), and the `relay_locks_held` gauge where the
 * relay's metrics take gauges.
 *
 * - **Store:** Redis (`ctx.redis.kv`).
 * - **Server frames:** B044's `emitServerBatch` (deny, expire, grants outside a client's batch);
 *   looked up when needed (the fan-out module registers later).
 * - **Conflict hints:** none until B061 provides its port.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { newId } from '@centcom/contracts';
import type { TelemetryMetrics } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { LEAVE_GRACE_MS } from './ports.js';
import { LockService } from './service.js';
import { lockStage } from './stage.js';
import { createRedisLockStore } from './store.js';

/** Attempts at recording a member's join, JOIN_RETRY_MS apart. */
const JOIN_ATTEMPTS = 5;
const JOIN_RETRY_MS = 1_000;

/** How often expired locks are swept. */
export const LOCK_SWEEP_MS = 1_000;

const relayModule: RelayModule = {
  name: 'locks',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const service = new LockService({
      store: createRedisLockStore({ kv: ctx.redis.kv, clock: ctx.clock }),
      emitter: {
        async emit(sid, frames) {
          const fanout = ctx.fanout;
          if (fanout === undefined) throw new Error('locks: the relay has no fan-out');
          await fanout.emitServerBatch(
            sid,
            frames.map((p) => ({ kind: 'file.lock', t: 'event' as const, p: { ...p } })),
          );
        },
      },
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    // This node's name (B045's when the cluster registers; it registers after this module).
    const localNode = newId('req').slice(4);
    const node = (): string => ctx.cluster?.nodeId ?? localNode;
    // One pending grace per member of a session (its latest departure's).
    const graces = new Map<string, ReturnType<typeof setTimeout>>();
    const cancelGrace = (key: string): void => {
      clearTimeout(graces.get(key));
      graces.delete(key);
    };
    const warn = (sid: string) => (err: unknown) =>
      ctx.log.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'locks.cleanup_failed',
      );
    let stopping = false;
    // One join or leave write at a time per member of a session, in the order this node saw them.
    const chains = new Map<string, Promise<unknown>>();
    const serial = (sid: string, member: string, run: () => Promise<unknown>): void => {
      const key = `${sid}/${member}`;
      const done = (chains.get(key) ?? Promise.resolve())
        .then(run)
        .catch(warn(sid))
        .finally(() => {
          if (chains.get(key) === done) chains.delete(key);
        });
      chains.set(key, done);
    };
    const connectedHere = (sid: string, member: string): boolean =>
      rooms.registry.get(sid)?.hasMember(member) ?? false;
    // A join must land (it clears a departure mark another node's grace would act on): retried
    // while the member stays connected here.
    const record = async (sid: string, member: string): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        try {
          await service.memberJoined(sid, member, node());
          return;
        } catch (err) {
          if (attempt >= JOIN_ATTEMPTS || stopping || !connectedHere(sid, member)) throw err;
          await new Promise((resolve) => setTimeout(resolve, JOIN_RETRY_MS).unref());
        }
      }
    };
    rooms.registry.listen({
      joined(room, _conn, member) {
        service.watch(room.sid);
        // Its first connection on this node (later ones change nothing in the record).
        if (stopping || room.connectionsOf(member.id).length !== 1) return;
        cancelGrace(`${room.sid}/${member.id}`);
        serial(room.sid, member.id, () => record(room.sid, member.id));
      },
      left(room, _conn, member) {
        if (stopping || room.hasMember(member.id)) return;
        const sid = room.sid;
        const key = `${sid}/${member.id}`;
        serial(sid, member.id, async () => {
          // Back on this node while the leave waited: its join (queued after) records it again.
          if (connectedHere(sid, member.id)) return;
          const mark = await service.memberLeft(sid, member.id, node());
          if (mark === undefined || stopping) return;
          // Gone from every node: after the reconnect grace, free its locks unless it is back
          // (here, or anywhere: a rejoin clears the departure's mark).
          cancelGrace(key);
          const timer = setTimeout(() => {
            if (graces.get(key) === timer) graces.delete(key);
            if (stopping) return;
            serial(sid, member.id, () =>
              connectedHere(sid, member.id)
                ? service.memberJoined(sid, member.id, node())
                : service.releaseIfGone(sid, member.id, mark),
            );
          }, LEAVE_GRACE_MS);
          timer.unref();
          graces.set(key, timer);
        });
      },
    });
    const timer = setInterval(() => {
      void service.sweep(new Date(ctx.clock()));
    }, LOCK_SWEEP_MS);
    timer.unref();
    ctx.onShutdown(() => {
      // A member who leaves during the drain keeps its locks until their TTL (no timer survives).
      stopping = true;
      clearInterval(timer);
      for (const grace of graces.values()) clearTimeout(grace);
      graces.clear();
      return Promise.resolve();
    });
    const metrics = ctx.metrics as Partial<TelemetryMetrics>;
    if (typeof metrics.gauge === 'function') {
      metrics.gauge('relay_locks_held', () => service.heldCount());
    }
    ctx.pipeline.use(
      STAGE_ORDER.queue,
      lockStage({ service, rooms: rooms.registry, logger: ctx.log }),
    );
    return undefined;
  },
};

export default relayModule;
