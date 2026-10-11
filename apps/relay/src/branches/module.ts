/**
 * The branches relay module (B061, order 39 = STAGE_ORDER.queue, beside the queue, agents,
 * approvals and locks stages): the branches stage, and `ctx.conflicts` (B059's locks module, which
 * registers after this one, tells it of every contested acquire).
 *
 * - **Agents:** B057's registry (`ctx.agents.snapshot`), looked up per signal.
 * - **Connected:** a connection in this node's room, else B051's marker on Redis.
 * - **Mode:** every session is a command post until sessions store a mode (as B057).
 * - **Gate:** Redis (`SET NX PX` for the 30 s windows; B009's sliding-window limiter for the
 *   server's 10 signals per session per second).
 * - **Server signals:** B044's `emitServer`, looked up when needed (the fan-out registers later).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RedisBackend } from '@centcom/core';
import { commandPostSessions } from '../agents/ports.js';
import { connectedKey } from '../control/connections.js';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { BranchHandler } from './branch-handler.js';
import { ConflictSignal } from './conflict-signal.js';
import { SERVER_SIGNALS_PER_SECOND, type SignalGate } from './ports.js';
import { branchStage } from './stage.js';

/** The 30 s windows (`SET NX PX`) and the server's signal rate (B009's sliding window), on Redis. */
export function redisSignalGate(redis: Pick<RedisBackend, 'kv' | 'rateLimit'>): SignalGate {
  const kv = redis.kv;
  return {
    async mark(key, value, ms) {
      if (await kv.setIfAbsent(key, value, ms)) return true;
      return (await kv.get(key)) ?? '';
    },
    async unmark(key, value) {
      if ((await kv.get(key)) === value) await kv.del(key);
    },
    async take(sid) {
      const r = await redis.rateLimit.consume(
        `conflict-signals:${sid}`,
        SERVER_SIGNALS_PER_SECOND,
        1,
      );
      return r.allowed;
    },
  };
}

const relayModule: RelayModule = {
  name: 'branches',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const kv = ctx.redis.kv;
    const conflicts = new ConflictSignal({
      agents: {
        async agents(sid) {
          const registry = ctx.agents;
          if (registry === undefined) return [];
          return (await registry.snapshot(sid)).map((a) => ({
            agentId: a.agentId,
            owner: a.owner,
            exited: a.exited !== undefined,
          }));
        },
      },
      connected: {
        async isConnected(sid, member) {
          if (rooms.registry.get(sid)?.hasMember(member) === true) return true;
          return (await kv.get(connectedKey(sid, member))) !== null;
        },
      },
      modes: commandPostSessions,
      gate: redisSignalGate(ctx.redis),
      emitter: {
        async emit(sid, p) {
          const fanout = ctx.fanout;
          if (fanout === undefined) throw new Error('branches: the relay has no fan-out');
          await fanout.emitServer(sid, 'conflict.detected', 'event', { ...p });
        },
      },
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    const branches = new BranchHandler({ modes: commandPostSessions, metrics: ctx.metrics });
    ctx.pipeline.use(
      STAGE_ORDER.queue,
      branchStage({ branches, conflicts, rooms: rooms.registry }),
    );
    ctx.conflicts = conflicts;
    return undefined;
  },
};

export default relayModule;
