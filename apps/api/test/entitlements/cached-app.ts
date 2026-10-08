/**
 * B069's entitlement routes served through B080's cache, on the workspace routes' plugin stack:
 * the app for entitlements.cached-route.test.ts and route-bench.ts. `reads()` counts the reads
 * that reached the source (B069's service, standing in for SQL).
 */
import { createMemoryRedis } from '@centcom/core';
import { CachedEntitlements } from '../../src/modules/entitlements/enforcement.js';
import { EntitlementService } from '../../src/modules/entitlements/service.js';
import { QuotaService } from '../../src/modules/usage/quota.js';
import { entitlementRoutes } from '../../src/routes/entitlements/index.js';
import { workspacesApp, type MemoryWorkspaceStore } from '../modules/workspaces/helpers.js';
import { MemoryCounterStore } from '../usage/aggregation/helpers.js';
import { Clock, MemoryEntitlementRepository } from './helpers.js';

/** The app, and how many reads reached the source. */
export async function cachedApp() {
  const clock = new Clock();
  const ref: { store?: MemoryWorkspaceStore } = {};
  const source = new EntitlementService({
    repository: new MemoryEntitlementRepository(
      (id) => ref.store?.workspaces.get(id)?.deletedAt === null,
    ),
    events: createMemoryRedis().pubsub,
    clock: clock.read,
  });
  let reads = 0;
  const cached = new CachedEntitlements({
    source: {
      get: (ws) => {
        reads += 1;
        return source.get(ws);
      },
    },
    quota: new QuotaService({
      counters: new MemoryCounterStore(),
      entitlements: source,
      rev: source,
    }),
    clock: clock.read,
  });
  const base = await workspacesApp({
    beforeReady: async (app) => {
      await app.register(entitlementRoutes, { service: cached });
    },
  });
  ref.store = base.store;
  return { ...base, reads: () => reads };
}
