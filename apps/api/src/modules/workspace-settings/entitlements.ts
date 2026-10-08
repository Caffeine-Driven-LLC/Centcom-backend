/**
 * What settings read from entitlements (B034, CT-ENTITLEMENTS): a workspace's `history_days`,
 * the cap of its retention override. B069 computes entitlements and provides the reader; until
 * then the free plan's seed value (0 days, the lowest of the plans) is the safe stand-in, since a
 * cap can only be too strict, never too lenient.
 *
 * Owns: the port. Must not: compute entitlements.
 */

/** Reads a workspace's `history_days`; rejects when entitlements are unavailable. */
export interface HistoryDaysReader {
  historyDays(workspaceId: string): Promise<number>;
}

/** The free plan's `history_days` (CT-ENTITLEMENTS §3 seed values). */
export const FREE_PLAN_HISTORY_DAYS = 0;

/** Every workspace on the free plan's cap (until B069's reader exists). */
export const freePlanHistoryDays: HistoryDaysReader = {
  historyDays: () => Promise.resolve(FREE_PLAN_HISTORY_DAYS),
};
