/**
 * The agents relay module (B057, order 39 = STAGE_ORDER.queue, beside B052's queue stage: after the
 * control stage's mutes, before sequencing): the agents stage, and `ctx.agents` (the registry:
 * `snapshot` for roster and join flows, `setStateValidator` for B058).
 *
 * - **Store:** Redis (`ctx.redis.kv`) with the Postgres write-through (`agent` table).
 * - **Limit:** `max_parallel_agents` of the session's plan, cached 30 s.
 * - **Rate limit:** 2 `agent.state` per agent per second (sliding), B009's Redis rate limiter.
 * - **Gauge:** `relay_agents_live{mode}` from the registry, when the relay's metrics take gauges.
 * - A session's view on this node is forgotten when its last member here leaves.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { TelemetryMetrics } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import type { AccessDbClient } from '../rooms/access.js';
import { createPostgresAgentEntitlements } from './entitlements.js';
import { agentStage } from './handler.js';
import { AgentRegistry } from './registry.js';
import { createStateRateLimiter } from './state-rate-limit.js';
import { createRedisAgentStore, type AgentsDb } from './store.js';

const relayModule: RelayModule = {
  name: 'agents',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const registry = new AgentRegistry({
      // The relay's client reaches every table; the agent table is typed in @centcom/db.
      store: createRedisAgentStore({
        kv: ctx.redis.kv,
        db: ctx.db as unknown as AgentsDb,
        clock: ctx.clock,
      }),
      entitlements: createPostgresAgentEntitlements({
        db: ctx.db as unknown as AccessDbClient,
        clock: ctx.clock,
      }),
      rateLimit: createStateRateLimiter({ store: ctx.redis.rateLimit, clock: ctx.clock }),
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    rooms.registry.listen({
      joined: () => undefined,
      left(room) {
        if (room.memberCount() === 0) registry.forget(room.sid);
      },
    });
    // `relay_agents_live{mode}`, read at each export where the relay's metrics take gauges.
    const metrics = ctx.metrics as Partial<TelemetryMetrics>;
    if (typeof metrics.gauge === 'function') {
      metrics.gauge('relay_agents_live', () =>
        Object.entries(registry.liveByMode()).map(([mode, value]) => ({ value, labels: { mode } })),
      );
    }
    ctx.pipeline.use(
      STAGE_ORDER.queue,
      agentStage({ registry, rooms: rooms.registry, logger: ctx.log }),
    );
    ctx.agents = registry;
    return undefined;
  },
};

export default relayModule;
