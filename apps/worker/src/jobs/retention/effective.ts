/**
 * Effective retention (B090, CT-ENTITLEMENTS "Retention override" and "On downgrade: no data is
 * deleted immediately"):
 *
 * - **Effective history days:** the plan's `history_days` (the free plan's 0 included), shortened
 *   by the workspace's retention override when that is smaller; an override never lengthens it.
 * - **Shortening never deletes at once:** the job keeps the days it enforces per workspace and
 *   dataset (`history`, `audit`). When the effective days drop below them, it records a pending
 *   shortening: the old days stay enforced until `effective_at` (7 days later). For history the
 *   notice and the owners' email go out once, and the 7 days count from the later of the two, so
 *   a send that failed and went out late still leaves 7 days; audit has no notice and just waits.
 *   Retention back to the old days or more withdraws the shortening and enforces the effective
 *   days at once; a further drop restarts the 7 days (and the notice); a partial rise keeps them.
 *   Growing retention takes effect at once. A workspace seen for the first time takes its
 *   effective days as the baseline, without notice: the job has no record of what it kept before,
 *   so a downgrade made before its first live run applies at once (docs/platform/data-retention.md).
 * - **The nightly slot:** a shortening applies from APPLY_TOLERANCE_MS before its time (for
 *   history, 7 days after the later of its notice and email went out), so a run that starts a
 *   little early in its slot still applies it; a notice sent later in its run than that applies a
 *   night later, never earlier.
 *
 * `decideRetention` is pure: it says what to enforce today and what to write; `recordDecision`
 * writes it.
 *
 * Owns: the arithmetic and the bookkeeping port. Must not: read or delete data.
 */
import { daysBefore } from './policy.js';

/** How long a shortened retention waits after its notice. */
export const DOWNGRADE_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
/** How early in its slot the run that applies a shortening may start. */
export const APPLY_TOLERANCE_MS = 4 * 60 * 1000;

/** The datasets whose retention follows the workspace's plan. */
export type RetentionDataset = 'history' | 'audit';

/** The days a workspace's history is kept: the plan's, or a smaller override. */
export function effectiveHistoryDays(planDays: number, overrideDays: number | null): number {
  if (!Number.isSafeInteger(planDays) || planDays < 0) {
    throw new RangeError('history_days must be a whole number of days');
  }
  if (overrideDays === null) return planDays;
  if (!Number.isSafeInteger(overrideDays) || overrideDays < 0) {
    throw new RangeError('the retention override must be a whole number of days');
  }
  return Math.min(planDays, overrideDays);
}

/** A shortening announced and not in effect yet. */
export interface PendingShortening {
  oldDays: number;
  newDays: number;
  effectiveAt: Date;
  noticeSentAt: Date | null;
  emailSentAt: Date | null;
}

/** What the job knows of a workspace's dataset. */
export interface RetentionState {
  /** The days enforced so far; null for a workspace not seen before. */
  baseline: number | null;
  pending: PendingShortening | null;
}

/** What to write for a workspace's dataset. */
export type RetentionChange =
  | { kind: 'none' }
  | { kind: 'set_baseline'; days: number }
  /** A new shortening (or a further drop that restarts the notice): announce it. */
  | { kind: 'announce'; pending: PendingShortening }
  /** A rise inside an announced shortening, still below the old days: keep its time and notice. */
  | { kind: 'update_pending'; newDays: number }
  /** Retention back to the old days or more: forget the shortening, enforce `days` now. */
  | { kind: 'withdraw'; days: number }
  /** The 7 days are over: enforce the new days. */
  | { kind: 'apply'; days: number };

/** Today's decision. */
export interface RetentionDecision {
  /** The days to purge by today. */
  enforceDays: number;
  change: RetentionChange;
}

/** Whether a shortening must be told (history) or only wait (audit). */
export interface DecideOptions {
  requireNotice: boolean;
}

/** The instant a pending shortening may apply, or null while its notice is still owed. */
export function applicableAt(pending: PendingShortening, requireNotice: boolean): Date | null {
  if (!requireNotice) return pending.effectiveAt;
  if (pending.noticeSentAt === null || pending.emailSentAt === null) return null;
  const told = Math.max(pending.noticeSentAt.getTime(), pending.emailSentAt.getTime());
  return new Date(Math.max(pending.effectiveAt.getTime(), told + DOWNGRADE_NOTICE_MS));
}

/** What to enforce at `now`, for a workspace whose effective retention is `effective` days. */
export function decideRetention(
  state: RetentionState,
  effective: number,
  now: Date,
  options: DecideOptions = { requireNotice: true },
): RetentionDecision {
  const { baseline, pending } = state;
  if (pending !== null) {
    if (effective >= pending.oldDays) {
      return { enforceDays: effective, change: { kind: 'withdraw', days: effective } };
    }
    if (effective < pending.newDays) {
      return {
        enforceDays: pending.oldDays,
        change: { kind: 'announce', pending: announce(pending.oldDays, effective, now) },
      };
    }
    const at = applicableAt(pending, options.requireNotice);
    if (at !== null && now.getTime() >= at.getTime() - APPLY_TOLERANCE_MS) {
      return { enforceDays: effective, change: { kind: 'apply', days: effective } };
    }
    return {
      enforceDays: pending.oldDays,
      change:
        effective === pending.newDays
          ? { kind: 'none' }
          : { kind: 'update_pending', newDays: effective },
    };
  }
  if (baseline === null) {
    return { enforceDays: effective, change: { kind: 'set_baseline', days: effective } };
  }
  if (effective < baseline) {
    return {
      enforceDays: baseline,
      change: { kind: 'announce', pending: announce(baseline, effective, now) },
    };
  }
  if (effective > baseline) {
    return { enforceDays: effective, change: { kind: 'set_baseline', days: effective } };
  }
  return { enforceDays: baseline, change: { kind: 'none' } };
}

function announce(oldDays: number, newDays: number, now: Date): PendingShortening {
  return {
    oldDays,
    newDays,
    effectiveAt: new Date(now.getTime() + DOWNGRADE_NOTICE_MS),
    noticeSentAt: null,
    emailSentAt: null,
  };
}

/** Sessions that ended at or before this instant are past `days` of retention at `now`. */
export const purgeHorizon = (now: Date, days: number): Date => daysBefore(now, days);

/** The job's bookkeeping per workspace and dataset (`retention_baseline`, `retention_pending`). */
export interface RetentionStateStore {
  get(workspaceId: string, dataset: RetentionDataset): Promise<RetentionState>;
  setBaseline(workspaceId: string, dataset: RetentionDataset, days: number): Promise<void>;
  /** Records (or restarts) a pending shortening, with its marks cleared. */
  announce(
    workspaceId: string,
    dataset: RetentionDataset,
    pending: PendingShortening,
  ): Promise<void>;
  updatePending(workspaceId: string, dataset: RetentionDataset, newDays: number): Promise<void>;
  /** Makes `days` the baseline and forgets any pending shortening, in one transaction. */
  settle(workspaceId: string, dataset: RetentionDataset, days: number): Promise<void>;
  /** Marks the shortening's notice or email sent. */
  markSent(
    workspaceId: string,
    dataset: RetentionDataset,
    what: 'notice' | 'email',
    at: Date,
  ): Promise<void>;
}

/** Writes a decision's change; the pending shortening after it, if any. */
export async function recordDecision(
  store: RetentionStateStore,
  workspaceId: string,
  dataset: RetentionDataset,
  decision: RetentionDecision,
  state: RetentionState,
): Promise<PendingShortening | null> {
  const { change } = decision;
  switch (change.kind) {
    case 'none':
      return state.pending;
    case 'set_baseline':
      await store.setBaseline(workspaceId, dataset, change.days);
      return null;
    case 'announce':
      await store.announce(workspaceId, dataset, change.pending);
      return change.pending;
    case 'update_pending':
      await store.updatePending(workspaceId, dataset, change.newDays);
      return state.pending === null ? null : { ...state.pending, newDays: change.newDays };
    case 'withdraw':
    case 'apply':
      await store.settle(workspaceId, dataset, change.days);
      return null;
  }
}
