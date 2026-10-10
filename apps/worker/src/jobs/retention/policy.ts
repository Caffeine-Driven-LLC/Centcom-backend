/**
 * Retention policies (B090): what a policy is, what a run tells it, and the safety brakes every
 * policy applies.
 *
 * - A policy owns one dataset (history, audit events, a token table...): `run(ctx)` deletes what
 *   is past its retention at `ctx.now`, in batches (ROW_BATCH rows), and answers what it scanned,
 *   purged and skipped. It must be idempotent: a second run finds nothing to do, and a run that
 *   died half way is finished by the next one.
 * - **Dry run** (`ctx.dryRun`): count what is due, delete and write nothing.
 * - **Fraction brake:** before deleting anything, a policy calls `guardFraction(ctx, due, total)`;
 *   more than `ctx.maxDeleteFraction` of the table's rows due in one run aborts the policy with
 *   `fraction_exceeded` (nothing deleted), unless `ctx.force`. A dry run checks it too, so it
 *   reports what the real run would do.
 * - **Budget:** a policy stops cleanly between batches once `outOfTime(ctx)` (the run's 30 min
 *   are spent), reporting what is still due as `backlog`; the next run continues. A policy that
 *   first decides workspace by workspace and then acts (history, audit) stops deciding at
 *   `decideDeadlineOf` (DECIDE_SHARE of its budget), so it always has time to act on what it
 *   decided.
 *
 * Owns: the interface and the brakes. Must not: read, decrypt or log content, or log ids of what
 * it deletes (counts only).
 */

/** Rows a policy deletes per statement. */
export const ROW_BATCH = 1000;
/** How long one run (every policy) may take. */
export const RUN_BUDGET_MS = 30 * 60 * 1000;
/** The default largest share of a table one run may delete (RETENTION_MAX_DELETE_FRACTION). */
export const DEFAULT_MAX_DELETE_FRACTION = 0.2;

/** What a policy run is told. */
export interface RetentionContext {
  /** The run's instant: retention is measured back from it. */
  now: Date;
  /** Count only: delete and write nothing. */
  dryRun: boolean;
  /** Milliseconds left of the run's budget when the policy starts. */
  budgetMs: number;
  /** The largest share (0..1] of a table one run may delete. */
  maxDeleteFraction: number;
  /** Ignore the fraction brake (RETENTION_FORCE). */
  force: boolean;
  /** Milliseconds now (the run's clock, for the budget). */
  clock: () => number;
}

/** What a policy run did. */
export interface RetentionResult {
  /** Items found due (rows, frames or workspaces, as the policy counts). */
  scanned: number;
  /** Items deleted (0 in a dry run). */
  purged: number;
  /** Items due but left (an entitlement lookup or a delete failed): retried next run. */
  skipped: number;
  /** Items still due when the budget ran out. */
  backlog?: number;
  /** Set when the budget ran out before the policy finished. */
  stopped?: 'budget_exceeded';
}

/** One dataset's retention. */
export interface RetentionPolicy {
  /** `snake_case`, unique; the `policy` label and `retention_runs.policy`. */
  readonly id: string;
  /** The lane that owns the dataset, for the docs and the report. */
  readonly owner: string;
  run(ctx: RetentionContext): Promise<RetentionResult>;
}

/** A policy stopped on purpose, deleting nothing; `scanned` is what was due. */
export class RetentionAbort extends Error {
  override name = 'RetentionAbort';
  constructor(
    readonly reason: 'fraction_exceeded',
    readonly scanned = 0,
  ) {
    super(`retention aborted: ${reason}`);
  }
}

/** Throws RetentionAbort when `due` is more than the allowed share of `total` (unless forced). */
export function guardFraction(ctx: RetentionContext, due: number, total: number): void {
  if (ctx.force || due === 0 || total === 0) return;
  // due / total > fraction, without dividing.
  if (due > ctx.maxDeleteFraction * total) throw new RetentionAbort('fraction_exceeded', due);
}

/** The run's deadline, from the policy's start. */
export const deadlineOf = (ctx: RetentionContext, startedAt: number): number =>
  startedAt + ctx.budgetMs;

/** The share of a policy's budget its deciding pass may use; the rest is for acting. */
export const DECIDE_SHARE = 0.5;

/** When a two-pass policy stops deciding, from its start. */
export const decideDeadlineOf = (ctx: RetentionContext, startedAt: number): number =>
  startedAt + Math.floor(ctx.budgetMs * DECIDE_SHARE);

/** True once the run's budget is spent. */
export const outOfTime = (ctx: RetentionContext, deadline: number): boolean =>
  ctx.clock() >= deadline;

/** `now` minus whole `days`. */
export const daysBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
