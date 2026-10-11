/**
 * The approvals relay module (B060, order 39 = STAGE_ORDER.queue, beside the queue, agents and
 * locks stages): the approvals stage, the expiry sweep (every APPROVAL_SWEEP_MS) over every session
 * a member joined on this node (a restarted node re-arms a session's approvals from Redis as soon
 * as a member joins), and the `relay_approvals_pending` gauge where the relay's metrics take
 * gauges.
 *
 * - **Store:** Redis (`ctx.redis.kv`).
 * - **Deciders:** Postgres (live roles and workspace roles) and B051's policy (`approvers`).
 * - **Agent owners:** B057's registry (`ctx.agents`), looked up per request.
 * - **Timeout deny:** B044's `emitServer` (`approval.decision`, from `srv`), looked up when needed
 *   (the fan-out module registers later).
 * - **Notifications:** a no-op port until the relay can publish to B063's dispatcher (no queue client in
 *   the relay yet; `notify.ts` is the adapter); the router calls the port once per approval.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { TelemetryMetrics } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import type { NotifyPort } from './ports.js';
import { createPostgresDeciders } from './postgres.js';
import { ApprovalRouter } from './router.js';
import { approvalStage } from './stage.js';
import { createRedisApprovalStore } from './store.js';

/** How often expired approvals are swept. */
export const APPROVAL_SWEEP_MS = 1_000;

/** Until the relay publishes to B063's dispatcher (see README). */
const noNotifications: NotifyPort = { approvalNeeded: () => undefined };

const relayModule: RelayModule = {
  name: 'approvals',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const deciders = createPostgresDeciders(ctx.db);
    const router = new ApprovalRouter({
      store: createRedisApprovalStore({ kv: ctx.redis.kv, clock: ctx.clock }),
      deciders: {
        get: (sid, mid) => deciders.get(sid, mid),
        async approvers(sid) {
          const policies = ctx.control?.policies;
          return policies === undefined ? [] : (await policies.get(sid)).approvers;
        },
      },
      agents: {
        async ownerOf(sid, agentId) {
          const agents = ctx.agents;
          if (agents === undefined) return undefined;
          return (await agents.snapshot(sid)).find((a) => a.agentId === agentId)?.owner;
        },
      },
      notify: noNotifications,
      emitter: {
        async emitTimeout(sid, approvalId) {
          const fanout = ctx.fanout;
          if (fanout === undefined) throw new Error('approvals: the relay has no fan-out');
          await fanout.emitServer(sid, 'approval.decision', 'event', {
            approval_id: approvalId,
            decision: 'deny',
            scope: 'once',
          });
        },
      },
      audit: rooms.audit,
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    rooms.registry.listen({
      joined(room) {
        router.watch(room.sid);
      },
      left: () => undefined,
    });
    const timer = setInterval(() => {
      void router.sweep(new Date(ctx.clock()), (sid) => rooms.registry.get(sid) !== undefined);
    }, APPROVAL_SWEEP_MS);
    timer.unref();
    ctx.onShutdown(() => {
      clearInterval(timer);
      return Promise.resolve();
    });
    const metrics = ctx.metrics as Partial<TelemetryMetrics>;
    if (typeof metrics.gauge === 'function') {
      metrics.gauge('relay_approvals_pending', () => router.pendingCount());
    }
    ctx.pipeline.use(
      STAGE_ORDER.queue,
      approvalStage({ router, rooms: rooms.registry, logger: ctx.log }),
    );
    return undefined;
  },
};

export default relayModule;
