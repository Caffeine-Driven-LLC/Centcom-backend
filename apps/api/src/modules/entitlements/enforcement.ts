/**
 * Entitlement enforcement (B080, CT-ENTITLEMENTS): B069's entitlements behind the shared ≤ 30 s
 * cache (`@centcom/core` EntitlementCache), and the checks hosted features call.
 *
 * - **Reading:** `get` serves from the cache, which B069's `entitlements:invalidate` messages and
 *   `invalidate` keep current, and which reloads the moment a grace period or billing period ends,
 *   so a lapsed status shows as `none` even before any job runs. SQL (B069) stays the source of
 *   truth; `lan_multiplayer` always reads true.
 * - **Checking** (`check(workspace, key, current?)`):
 *   - `lan_multiplayer` is always allowed, without a lookup;
 *   - a flag (`relay_access`) is allowed when true, else `flag_off`;
 *   - a count is allowed when its limit is null, or above `current` (with no `current`, above 0;
 *     0 always denies), else `count_reached`;
 *   - a metered limit (`hosted_minutes_month`, `queue_items_month`) asks B075's authoritative
 *     counters (`QuotaService.check`), never the cached `usage`, else `quota_reached` with
 *     `retry_after_s` to the period's end.
 * - **Failing closed:** when the entitlements cannot be read (Postgres down and no fresh entry),
 *   `get` and `check` throw 503 with `retry_after_s`, never "allowed". A failure is never cached.
 *
 * Configuration: ENT_CACHE_TTL_MS (1 to 30 000, default 30 000), ENT_STALE_ON_ERROR_MS (default 0).
 *
 * Owns: the read path and the checks. Must not: trust a client's plan, role or `ent` claim, or let a
 * check block LAN or local use.
 */
import {
  defineConfig,
  EntitlementCache,
  envInt,
  isAppError,
  listenForInvalidations,
  MAX_ENT_CACHE_TTL_MS,
  noopMetrics,
  notFound,
  unavailable,
  z,
  type Env,
  type Logger,
  type Metrics,
  type PubSub,
  type Unsubscribe,
} from '@centcom/core';
import {
  ENTITLEMENTS_INVALIDATE_CHANNEL,
  FLAG_KEYS,
  LIMIT_KEYS,
  type Entitlements,
  type LimitKey,
} from './ports.js';
import { ENTITLEMENT_DETAILS } from './service.js';

/** The metered limits, checked against B075's counters. */
export const METERED_KEYS: ReadonlySet<LimitKey> = new Set([
  'hosted_minutes_month',
  'queue_items_month',
]);

/** Seconds a caller waits after the entitlements could not be read. */
export const ENT_RETRY_AFTER_S = 5;

/** The details of enforcement's refusals (GUIDELINES §3.4). */
export const ENFORCEMENT_DETAILS = Object.freeze({
  unavailable: 'Plan limits cannot be checked right now. Try again shortly.',
} as const);

/** What a check decides. */
export type CheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'flag_off' | 'count_reached' | 'quota_reached';
      retry_after_s?: number;
    };

/** The read side B080 serves (the card's `EntitlementService` interface). */
export interface EntitlementEnforcer {
  get(workspaceId: string): Promise<Entitlements>;
  getRev(workspaceId: string): Promise<number>;
  invalidate(workspaceId: string): Promise<void>;
  check(workspaceId: string, key: LimitKey, current?: number): Promise<CheckResult>;
}

/** The environment keys of the cache. */
export const entitlementCacheEnvSchema = z.object({
  ENT_CACHE_TTL_MS: envInt({ min: 1, max: MAX_ENT_CACHE_TTL_MS })
    .default(MAX_ENT_CACHE_TTL_MS)
    .meta({
      description: 'How long an API process serves cached entitlements (at most 30 000 ms).',
    }),
  ENT_STALE_ON_ERROR_MS: envInt({ min: 0, max: 60_000 }).default(0).meta({
    description: 'How far past freshness cached entitlements may stand in when Postgres fails.',
  }),
});

/** Reads the cache settings; a ConfigError for a TTL over 30 s. */
export function loadEntitlementCacheConfig(env?: Env): { ttlMs: number; staleOnErrorMs: number } {
  const v = defineConfig(entitlementCacheEnvSchema, env);
  return { ttlMs: v.ENT_CACHE_TTL_MS, staleOnErrorMs: v.ENT_STALE_ON_ERROR_MS };
}

/** When cached entitlements must be reloaded: the end of their grace or billing period. */
export function entitlementsExpireAt(value: Entitlements): number | null {
  const times: number[] = [];
  if (value.grace_until !== null && value.grace_until !== undefined) {
    times.push(Date.parse(value.grace_until));
  }
  if (value.period !== undefined) times.push(Date.parse(value.period.end));
  const valid = times.filter((t) => Number.isFinite(t));
  return valid.length === 0 ? null : Math.min(...valid);
}

/** What the enforcer needs. */
export interface CachedEntitlementsDeps {
  /** B069's `EntitlementService.get` (SQL, the source of truth). */
  source: { get(workspaceId: string): Promise<Entitlements | null> };
  /** B075's `QuotaService.check` (authoritative counters). */
  quota: {
    check(
      workspaceId: string,
      key: 'hosted_minutes_month' | 'queue_items_month',
    ): Promise<{ allowed: boolean; retryAfterS: number | null }>;
  };
  /** Invalidations: listened to by `start`, published by `invalidate`. */
  pubsub?: Pick<PubSub, 'publish' | 'subscribe'>;
  ttlMs?: number;
  staleOnErrorMs?: number;
  maxEntries?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `ent_cache_loads_total`, `ent_cache_load_failures_total`, `ent_cache_stale_served_total`. */
  metrics?: Metrics;
}

/** B069's entitlements behind the cache, with the checks. */
export class CachedEntitlements implements EntitlementEnforcer {
  readonly #cache: EntitlementCache<Entitlements>;
  readonly #metrics: Metrics;
  #unsubscribe: Unsubscribe | null = null;

  constructor(private readonly deps: CachedEntitlementsDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#cache = new EntitlementCache<Entitlements>({
      load: async (workspaceId) => {
        this.#metrics.counter('ent_cache_loads_total').inc();
        return deps.source.get(workspaceId);
      },
      expiresAt: entitlementsExpireAt,
      ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
      ...(deps.staleOnErrorMs === undefined ? {} : { staleOnErrorMs: deps.staleOnErrorMs }),
      ...(deps.maxEntries === undefined ? {} : { maxEntries: deps.maxEntries }),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      onStaleServed: () => this.#metrics.counter('ent_cache_stale_served_total').inc(),
    });
  }

  /** Listens for invalidations from every process (B069 publishes them on change). */
  async start(): Promise<void> {
    if (this.deps.pubsub === undefined || this.#unsubscribe !== null) return;
    this.#unsubscribe = await listenForInvalidations(
      this.deps.pubsub,
      ENTITLEMENTS_INVALIDATE_CHANNEL,
      this.#cache,
    );
  }

  /** Stops listening. */
  async stop(): Promise<void> {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    await unsubscribe?.();
  }

  /** The workspace's entitlements; 404 for none, 503 when they cannot be read. */
  async get(workspaceId: string): Promise<Entitlements> {
    let value: Entitlements | null;
    try {
      value = await this.#cache.get(workspaceId);
    } catch (err) {
      this.#metrics.counter('ent_cache_load_failures_total').inc();
      this.deps.logger?.warn(
        { workspace_id: workspaceId, error: (err as Error).name },
        'entitlements.read_failed',
      );
      throw unavailable(ENT_RETRY_AFTER_S, ENFORCEMENT_DETAILS.unavailable, {
        cause: new Error('entitlements unavailable'),
      });
    }
    if (value === null) throw notFound(ENTITLEMENT_DETAILS.notFound);
    return { ...value, limits: { ...value.limits, lan_multiplayer: true } };
  }

  /** The workspace's revision (the access token's `ent` claim). */
  async getRev(workspaceId: string): Promise<number> {
    return (await this.get(workspaceId)).rev;
  }

  /** Drops the workspace's entry here, and announces its current revision to every process. */
  async invalidate(workspaceId: string): Promise<void> {
    this.#cache.invalidate(workspaceId);
    if (this.deps.pubsub === undefined) return;
    const rev = await this.getRev(workspaceId);
    await this.deps.pubsub.publish(
      ENTITLEMENTS_INVALIDATE_CHANNEL,
      JSON.stringify({ workspace: workspaceId, rev }),
    );
  }

  /** Whether the workspace may use `key` (see the module comment). */
  async check(workspaceId: string, key: LimitKey, current?: number): Promise<CheckResult> {
    if (key === 'lan_multiplayer') return { allowed: true };
    if (!LIMIT_KEYS.includes(key)) return { allowed: true };
    if (METERED_KEYS.has(key)) {
      const metered = key as 'hosted_minutes_month' | 'queue_items_month';
      let result: { allowed: boolean; retryAfterS: number | null };
      try {
        result = await this.deps.quota.check(workspaceId, metered);
      } catch (err) {
        if (isAppError(err) && err.code === 'not_found') throw err;
        this.deps.logger?.warn(
          { workspace_id: workspaceId, error: (err as Error).name },
          'entitlements.quota_check_failed',
        );
        throw unavailable(ENT_RETRY_AFTER_S, ENFORCEMENT_DETAILS.unavailable, {
          cause: new Error('quota unavailable'),
        });
      }
      return result.allowed
        ? { allowed: true }
        : {
            allowed: false,
            reason: 'quota_reached',
            ...(result.retryAfterS === null ? {} : { retry_after_s: result.retryAfterS }),
          };
    }
    const limits = (await this.get(workspaceId)).limits as Record<string, unknown>;
    const limit = limits[key];
    if (FLAG_KEYS.has(key))
      return limit === true ? { allowed: true } : { allowed: false, reason: 'flag_off' };
    if (limit === null) return { allowed: true };
    if (typeof limit !== 'number') return { allowed: false, reason: 'count_reached' };
    const used = current ?? 0;
    return used < limit ? { allowed: true } : { allowed: false, reason: 'count_reached' };
  }
}
