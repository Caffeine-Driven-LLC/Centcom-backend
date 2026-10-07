/**
 * Plan summary for `/v1/me` (B022, CT-ENTITLEMENTS): the plan and entitlement revision come from
 * an `EntitlementsLookup` the billing lanes provide. Until then everyone is on `free`, revision 0.
 * When the lookup fails, `/v1/me` still answers, with the free plan, and the failure is logged at
 * most once a minute (`entitlements_unavailable`) and counted.
 *
 * Owns: the fallback. Must not: fail a `/v1/me` read because billing is down.
 */
import type { Logger, Metrics } from '@centcom/core';

/** Plans (CT-ENTITLEMENTS). */
export type Plan = 'free' | 'pro' | 'team';

/** A user's plan as billing sees it. */
export interface PlanSummary {
  plan: Plan;
  /** Billing's status of the plan, such as `active`, `trialing`, `past_due`. */
  status: string;
  /** Entitlement revision: the `ent` clients compare to know when to refetch entitlements. */
  rev: number;
}

/** Where plans come from (the billing lanes). */
export interface EntitlementsLookup {
  forUser(userId: string, workspaceId?: string): Promise<PlanSummary>;
}

/** The free plan, revision 0: the default and the fallback. */
export const FREE_PLAN: Readonly<PlanSummary> = Object.freeze({
  plan: 'free',
  status: 'active',
  rev: 0,
});

/** Everyone on the free plan (until billing exists). */
export const freePlanLookup: EntitlementsLookup = {
  forUser: () => Promise.resolve({ ...FREE_PLAN }),
};

const PLANS: ReadonlySet<string> = new Set<Plan>(['free', 'pro', 'team']);

/**
 * `inner`, answering the free plan when it fails or returns something unusable; the failure is
 * counted (`entitlements_unavailable_total`) and logged at most once a minute.
 */
export function withFreePlanFallback(
  inner: EntitlementsLookup,
  deps: { logger?: Logger; metrics?: Metrics; now?: () => number } = {},
): EntitlementsLookup {
  const now = deps.now ?? Date.now;
  let lastLogged = Number.NEGATIVE_INFINITY;
  const fallback = (err: unknown): PlanSummary => {
    deps.metrics?.counter('entitlements_unavailable_total').inc();
    if (now() - lastLogged >= 60_000) {
      lastLogged = now();
      deps.logger?.warn({ err }, 'entitlements_unavailable: answering with the free plan');
    }
    return { ...FREE_PLAN };
  };
  return {
    async forUser(userId, workspaceId) {
      try {
        const summary = await inner.forUser(userId, workspaceId);
        if (
          !PLANS.has(summary.plan) ||
          !Number.isSafeInteger(summary.rev) ||
          summary.rev < 0 ||
          typeof summary.status !== 'string'
        ) {
          return fallback(new Error('the entitlements lookup returned an unusable plan'));
        }
        return summary;
      } catch (err) {
        return fallback(err);
      }
    },
  };
}
