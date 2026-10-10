/**
 * `max_parallel_agents` of a session's plan (B057; CT-ENTITLEMENTS: "relay checks agent.spawn"),
 * read the way B043's access reads `max_session_members`: the workspace's effective plan
 * (`effectivePlan`, B069's rules) and its `plan_limits` row. A null limit is no limit
 * (CT-ENTITLEMENTS); a plan without the row is an error, so the spawn is refused (fail closed). A
 * session outside any workspace has the free plan's.
 *
 * Cached per session for 30 s (card failure mode: a spawn uses the entitlement known at that
 * time; a downgrade reaches the relay within 30 s). A failed read is not cached: the registry
 * refuses the spawn (503) and the next one reads again.
 *
 * Owns: the read and its cache. Must not: decide the limit (the registry does).
 */
import { effectivePlan, type AccessDbClient } from '../rooms/access.js';
import type { EntitlementsPort } from './ports.js';

/** How long a session's limit is reused. */
export const ENTITLEMENT_CACHE_MS = 30_000;
/** Most sessions cached at once. */
const CACHE_MAX = 10_000;

/** The limit from Postgres, cached. */
export function createPostgresAgentEntitlements(deps: {
  db: AccessDbClient;
  clock: () => number;
}): EntitlementsPort {
  const cache = new Map<string, { at: number; max: number | null }>();
  return {
    async maxParallelAgents(sid) {
      const now = deps.clock();
      const hit = cache.get(sid);
      if (hit !== undefined && now - hit.at < ENTITLEMENT_CACHE_MS) return hit.max;
      const session = await deps.db
        .selectFrom('sessions')
        .select('workspace_id')
        .where('id', '=', sid)
        .executeTakeFirst();
      const workspaceId = session?.workspace_id ?? null;
      const state =
        workspaceId === null
          ? undefined
          : await deps.db
              .selectFrom('workspace_entitlements')
              .select(['plan_id', 'status', 'grace_until', 'period_end'])
              .where('workspace_id', '=', workspaceId)
              .executeTakeFirst();
      const plan = effectivePlan(state, new Date(now));
      const row = await deps.db
        .selectFrom('plan_limits')
        .select('int_value')
        .where('plan_id', '=', plan as 'free')
        .where('key', '=', 'max_parallel_agents')
        .executeTakeFirst();
      // A null value is unlimited (CT-ENTITLEMENTS); a missing row is an error (fail closed).
      if (row === undefined) throw new Error('the plan has no max_parallel_agents limit');
      const max = row.int_value;
      cache.delete(sid);
      cache.set(sid, { at: now, max });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return max;
    },
  };
}
