/**
 * Entitlements (B069, CT-ENTITLEMENTS): what each workspace may do, and its revision `rev`.
 *
 * - **Read:** a workspace's row resolved at the current time (resolve.ts), with usage and warnings
 *   from the UsageReaderPort (empty until B075; a failing reader gives none, counted and logged).
 *   The first read writes the workspace's default row (free, none). When the result changed
 *   without a state change (grace or a canceled period ended, or the plan's limits changed), the
 *   read moves `rev` on under the row's lock, as a change would.
 * - **Change:** `applySubscriptionState` writes billing's state and, in the same transaction,
 *   moves `rev` on by 1 when the resolved plan, status or limits changed (the stored digest says
 *   what `rev` was issued for); an identical state leaves `rev` alone. A refused state (unknown
 *   plan, bad seats or period) writes nothing and is counted for alerting.
 * - **Announce:** after a commit that moved `rev`, `{workspace, rev}` goes out on
 *   `entitlements:invalidate`, retried once; a failure is counted and logged and never undoes
 *   the change (caches expire within 30 s).
 * - **Plans:** the public catalog, limits from the `plan_limits` rows and prices from the seed.
 *
 * Owns: the rules above. Must not: decide who may read (the routes' RBAC does), read Stripe, or
 * publish before the commit.
 */
import { notFound, noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { Api } from '@centcom/contracts';
import {
  emptyUsageReader,
  ENTITLEMENTS_INVALIDATE_CHANNEL,
  isPlanId,
  LIMIT_KEYS,
  PLAN_IDS,
  type BumpReason,
  type Entitlements,
  type EntitlementLimits,
  type InvalidationPublisher,
  type Period,
  type PlanId,
  type SubscriptionState,
  type UsageReaderPort,
  type UsageReport,
} from './ports.js';
import type { EntitlementRepository, StoredEntitlement } from './repository.js';
import {
  EntitlementError,
  graceUntilFor,
  resolvedDigest,
  resolveEntitlements,
  type PlanCatalog,
  type Resolved,
} from './resolve.js';
import { SEED_PLANS, validateSeedPlans, type SeedPlans } from './seed-plans.js';

/** How long the plan catalog is cached, in milliseconds. */
export const CATALOG_TTL_MS = 60_000;
/** Publishing an invalidation is tried this many times. */
export const INVALIDATE_ATTEMPTS = 2;
/** The reasons `bumpRev` accepts. */
export const BUMP_REASONS: readonly BumpReason[] = Object.freeze([
  'usage_warning',
  'plan',
  'admin',
]);

/** The user-facing details of this module's problems (GUIDELINES §3.4). */
export const ENTITLEMENT_DETAILS = Object.freeze({
  notFound: 'There is no such workspace.',
} as const);

/** Options for EntitlementService. */
export interface EntitlementServiceOptions {
  repository: EntitlementRepository;
  /** Announces new revisions (B009 `RedisBackend.pubsub`). */
  events: InvalidationPublisher;
  /** Usage and warnings; default none (until B075). */
  usage?: UsageReaderPort;
  /** The plan seed, validated at construction; default SEED_PLANS. */
  seed?: unknown;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Default CATALOG_TTL_MS. */
  catalogTtlMs?: number;
  /** Writes `entitlements.*` lines (ids, revisions and codes only). */
  logger?: Logger;
  /**
   * Receives `entitlements_rev_changes_total{cause}` (`state`, `read` or a bump reason), `entitlements_state_rejected_total{code}`,
   * `entitlements_invalidate_failures_total` and `entitlements_usage_failures_total`.
   */
  metrics?: Metrics;
}

/** A catalog with the plans' names. */
interface Catalog {
  names: ReadonlyMap<PlanId, string>;
  limits: PlanCatalog;
}

/** Workspace entitlements. */
export class EntitlementService {
  /** The validated seed. */
  readonly seed: SeedPlans;
  readonly #o: EntitlementServiceOptions;
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly #usage: UsageReaderPort;
  readonly #ttl: number;
  #catalog: { at: number; value: Promise<Catalog> } | null = null;

  constructor(options: EntitlementServiceOptions) {
    this.seed = validateSeedPlans(options.seed ?? SEED_PLANS);
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
    this.#metrics = options.metrics ?? noopMetrics;
    this.#usage = options.usage ?? emptyUsageReader;
    this.#ttl = options.catalogTtlMs ?? CATALOG_TTL_MS;
  }

  /** The public plans, cheapest first (CT-API-BILLING `Plan`). */
  async plans(): Promise<Api.Plan[]> {
    const catalog = await this.#loadCatalog();
    const now = new Date(this.#clock());
    return PLAN_IDS.map((id) => ({
      id,
      name: catalog.names.get(id) ?? this.seed[id].name,
      prices: this.seed[id].prices.map((p) => ({ ...p, price: { ...p.price } })),
      limits: resolveEntitlements(
        { plan: id, status: 'active', period: null, grace_until: null, addonSeats: 0, now },
        catalog.limits,
      ).limits,
    }));
  }

  /** The entitlements of live workspace `workspaceId`; null when there is none. */
  async get(workspaceId: string): Promise<Entitlements | null> {
    const now = new Date(this.#clock());
    const { limits: catalog } = await this.#loadCatalog();
    let row = await this.#o.repository.find(workspaceId);
    if (row === null) return null;
    let resolved = resolveRow(row, catalog, now);
    if (!row.stored || !resolvedDigest(resolved).equals(row.digest ?? baseline(catalog, now))) {
      const synced = await this.#sync(workspaceId, catalog, now);
      if (synced === null) return null;
      ({ row, resolved } = synced);
    }
    const usage = await this.#readUsage(workspaceId, resolved.period);
    return {
      workspace: workspaceId,
      rev: row.rev,
      plan: resolved.plan,
      status: resolved.status,
      ...(resolved.period === null
        ? {}
        : {
            period: {
              start: resolved.period.start.toISOString(),
              end: resolved.period.end.toISOString(),
            },
          }),
      limits: resolved.limits,
      usage: usage.usage,
      warnings: usage.warnings,
      grace_until: resolved.grace_until?.toISOString() ?? null,
    };
  }

  /**
   * Writes billing's `state` for `workspaceId`. `rev` moves on by 1 when the resolved plan, status
   * or limits changed, and `{workspace, rev}` is announced after the commit. An EntitlementError
   * for a state that cannot be applied (nothing is written); 404 for no live workspace.
   */
  async applySubscriptionState(
    workspaceId: string,
    state: SubscriptionState,
  ): Promise<{ rev: number; changed: boolean }> {
    const now = new Date(this.#clock());
    const { limits: catalog } = await this.#loadCatalog();
    let resolved: Resolved;
    let graceUntil: Date | null;
    try {
      if (!isPlanId(state.plan)) throw new EntitlementError('unknown_plan', 'unknown plan');
      graceUntil =
        state.status === 'past_due'
          ? graceUntilFor(state.past_due_since ?? new Date(Number.NaN))
          : null;
      resolved = resolveEntitlements(
        {
          plan: state.plan,
          status: state.status,
          period: state.period,
          grace_until: graceUntil,
          addonSeats: state.addon_seats,
          now,
        },
        catalog,
      );
    } catch (err) {
      if (err instanceof EntitlementError) {
        this.#metrics.counter('entitlements_state_rejected_total', { code: err.code }).inc();
        this.#o.logger?.error(
          { workspace_id: workspaceId, reason: err.code },
          'entitlements.state_rejected',
        );
      }
      throw err;
    }
    const digest = resolvedDigest(resolved);
    const result = await this.#o.repository.transaction(async (tx) => {
      const row = await tx.lock(workspaceId);
      if (row === null) return null;
      const changed = !digest.equals(row.digest ?? baseline(catalog, now));
      const rev = changed ? row.rev + 1 : row.rev;
      await tx.write(workspaceId, {
        plan: state.plan,
        status: state.status,
        period: state.period,
        graceUntil,
        addonSeats: state.addon_seats,
        rev,
        digest,
      });
      return { rev, changed };
    });
    if (result === null) throw notFound(ENTITLEMENT_DETAILS.notFound);
    if (result.changed) await this.#announce(workspaceId, result.rev, 'state');
    return result;
  }

  /**
   * Moves `rev` on by 1 without a state change (B075's usage warnings), and announces it; 404
   * for no live workspace.
   */
  async bumpRev(workspaceId: string, reason: BumpReason): Promise<number> {
    if (!BUMP_REASONS.includes(reason)) throw new TypeError(`bumpRev: unknown reason "${reason}"`);
    const rev = await this.#o.repository.transaction(async (tx) => {
      const row = await tx.lock(workspaceId);
      if (row === null) return null;
      await tx.write(workspaceId, { ...stateOf(row), rev: row.rev + 1, digest: row.digest });
      return row.rev + 1;
    });
    if (rev === null) throw notFound(ENTITLEMENT_DETAILS.notFound);
    await this.#announce(workspaceId, rev, reason);
    return rev;
  }

  /** Re-resolves a workspace's row under its lock; moves `rev` on when the result changed. */
  async #sync(
    workspaceId: string,
    catalog: PlanCatalog,
    now: Date,
  ): Promise<{ row: StoredEntitlement; resolved: Resolved } | null> {
    const result = await this.#o.repository.transaction(async (tx) => {
      const row = await tx.lock(workspaceId);
      if (row === null) return null;
      const resolved = resolveRow(row, catalog, now);
      const digest = resolvedDigest(resolved);
      if (digest.equals(row.digest ?? baseline(catalog, now))) {
        return { row, resolved, changed: false };
      }
      const next = { ...row, rev: row.rev + 1, digest };
      await tx.write(workspaceId, { ...stateOf(next), rev: next.rev, digest });
      return { row: next, resolved, changed: true };
    });
    if (result?.changed === true) await this.#announce(workspaceId, result.row.rev, 'read');
    return result;
  }

  /** Publishes `{workspace, rev}`, retried once; a failure is counted and logged, not thrown. */
  async #announce(workspaceId: string, rev: number, cause: string): Promise<void> {
    this.#metrics.counter('entitlements_rev_changes_total', { cause }).inc();
    this.#o.logger?.info({ workspace_id: workspaceId, rev, cause }, 'entitlements.rev_changed');
    const message = JSON.stringify({ workspace: workspaceId, rev });
    for (let attempt = 1; attempt <= INVALIDATE_ATTEMPTS; attempt++) {
      try {
        await this.#o.events.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, message);
        return;
      } catch {
        // Retried once; then counted below.
      }
    }
    this.#metrics.counter('entitlements_invalidate_failures_total').inc();
    this.#o.logger?.error({ workspace_id: workspaceId, rev }, 'entitlements.invalidate_failed');
  }

  async #readUsage(workspaceId: string, period: Period | null): Promise<UsageReport> {
    try {
      return await this.#usage.read(workspaceId, period);
    } catch {
      this.#metrics.counter('entitlements_usage_failures_total').inc();
      this.#o.logger?.warn({ workspace_id: workspaceId }, 'entitlements.usage_failed');
      return { usage: {}, warnings: [] };
    }
  }

  /** The catalog, cached for the TTL; a failed load is not kept. */
  #loadCatalog(): Promise<Catalog> {
    const now = this.#clock();
    if (this.#catalog !== null && now - this.#catalog.at < this.#ttl) return this.#catalog.value;
    const value = this.#o.repository.plans().then((plans) => {
      const names = new Map<PlanId, string>();
      const limits = new Map<PlanId, EntitlementLimits>();
      for (const plan of plans) {
        names.set(plan.id, plan.name);
        limits.set(
          plan.id,
          Object.fromEntries(LIMIT_KEYS.map((k) => [k, plan.limits[k]])) as EntitlementLimits,
        );
      }
      return { names, limits };
    });
    const entry = { at: now, value };
    this.#catalog = entry;
    value.catch(() => {
      if (this.#catalog === entry) this.#catalog = null;
    });
    return value;
  }
}

/** A stored row's state, as `write` takes it. */
const stateOf = (
  row: StoredEntitlement,
): Omit<StoredEntitlement, 'workspaceId' | 'stored' | 'rev' | 'digest'> => ({
  plan: row.plan,
  status: row.status,
  period: row.period,
  graceUntil: row.graceUntil,
  addonSeats: row.addonSeats,
});

const resolveRow = (row: StoredEntitlement, catalog: PlanCatalog, now: Date): Resolved =>
  resolveEntitlements(
    {
      plan: row.plan,
      status: row.status,
      period: row.period,
      grace_until: row.graceUntil,
      addonSeats: row.addonSeats,
      now,
    },
    catalog,
  );

/** The digest of a row never resolved: the free plan with status none. */
const baseline = (catalog: PlanCatalog, now: Date): Buffer =>
  resolvedDigest(
    resolveEntitlements(
      { plan: 'free', status: 'none', period: null, grace_until: null, addonSeats: 0, now },
      catalog,
    ),
  );
