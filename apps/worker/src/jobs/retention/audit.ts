/**
 * Audit retention (B090, CT-API-AUDIT, CT-ENTITLEMENTS `audit_log_days`): a workspace's audit
 * events older than its `audit_log_days` are deleted, through `purge_audit_events()` (B036's
 * SECURITY DEFINER function, the one way rows leave the append-only table), ROW_BATCH at a time.
 * `audit_log_days = 0` (no audit log on the plan) keeps none.
 *
 * A lower `audit_log_days` (a downgrade) never deletes at once (CT-ENTITLEMENTS "On downgrade: no
 * data is deleted immediately"): the old days stay enforced for 7 days, as for history
 * (effective.ts), with no notice (none exists for audit; the plan change itself is announced).
 *
 * Two passes, as for history, in workspace id order from where the last run stopped (cursor.ts):
 * count what each workspace has due until DECIDE_SHARE of the budget is spent (a workspace whose
 * entitlements cannot be read is skipped, never taken for 0 days), apply the fraction brake over
 * the workspaces counted, then record the decisions and delete with the rest of the budget. A
 * spent budget leaves the cursor after the last workspace finished, so the next run continues
 * there and wraps around.
 *
 * The brake leaves out the workspaces that already enforced 0 days before this run (baseline 0,
 * nothing pending), and new ones seen for the first time at 0 days whose events are all younger
 * than FRESH_DAYS: everything they wrote since the last run is due every night by design, as for
 * the token tables. A workspace whose events would all go for the first time (a shortening to 0
 * that applies tonight, or old events seen for the first time at 0 days) stays under the brake.
 * Events outside any workspace (account-level actions) have no `audit_log_days` and are left
 * alone.
 *
 * Owns: these rules. Must not: read events' contents.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  decideRetention,
  recordDecision,
  type RetentionDecision,
  type RetentionState,
  type RetentionStateStore,
} from './effective.js';
import { readCursor, workspacesFrom, writeCursor, type DecideCursor } from './cursor.js';
import { daysLimit, type RetentionEntitlementsReader } from './history.js';
import {
  daysBefore,
  deadlineOf,
  decideDeadlineOf,
  guardFraction,
  outOfTime,
  ROW_BATCH,
  type RetentionContext,
  type RetentionPolicy,
  type RetentionResult,
} from './policy.js';

/** What the audit policy reads and deletes in Postgres. */
export interface AuditRetentionStore {
  /** Up to `limit` workspaces, by id after `after`, that have audit events. */
  workspacesWithEvents(after: string | null, limit: number): Promise<string[]>;
  /** The workspace's events created before `before`. */
  dueEvents(workspaceId: string, before: Date): Promise<number>;
  /** Every audit event (exact or a close estimate on a large table). */
  totalEvents(): Promise<number>;
  /** Deletes up to `limit` of the workspace's events created before `before`, oldest first. */
  purge(workspaceId: string, before: Date, limit: number): Promise<number>;
}

/** What the audit policy needs. */
export interface AuditPolicyDeps {
  store: AuditRetentionStore;
  /** The bookkeeping (enforced days, pending shortenings). */
  state: RetentionStateStore;
  /** Where the next run continues. */
  cursor: DecideCursor;
  entitlements: RetentionEntitlementsReader;
  logger?: Logger;
  metrics?: Metrics;
}

/** Workspaces read per page. */
export const AUDIT_WORKSPACE_PAGE = 500;
/** A workspace first seen at 0 days with no event older than this is new (outside the brake). */
export const FRESH_DAYS = 2;

/** What pass 1 decided for a workspace. */
interface Decided {
  decision: RetentionDecision;
  state: RetentionState;
  before: Date;
  due: number;
}

/** The audit policy. */
export function createAuditPolicy(deps: AuditPolicyDeps): RetentionPolicy {
  const metrics = deps.metrics ?? noopMetrics;
  const skip = (workspaceId: string, reason: string, err?: unknown): void => {
    metrics.counter('retention_workspaces_skipped_total', { policy: 'audit', reason }).inc();
    deps.logger?.warn(
      {
        workspace_id: workspaceId,
        reason,
        ...(err === undefined ? {} : { error: err instanceof Error ? err.name : 'unknown' }),
      },
      'retention.workspace_skipped',
    );
  };
  return {
    id: 'audit',
    owner: 'B036',
    async run(ctx: RetentionContext): Promise<RetentionResult> {
      const started = ctx.clock();
      const deadline = deadlineOf(ctx, started);
      const decideBy = decideDeadlineOf(ctx, started);
      const start = await readCursor(deps.cursor, 'audit', deps.logger);

      // Pass 1: count, from the cursor, until DECIDE_SHARE of the budget is spent.
      const order: string[] = [];
      const plan = new Map<string, Decided>();
      let due = 0;
      let unguarded = 0;
      let decideStopped = false;
      const workspaces = workspacesFrom(
        (after, limit) => deps.store.workspacesWithEvents(after, limit),
        start,
        AUDIT_WORKSPACE_PAGE,
      );
      for await (const workspaceId of workspaces) {
        if (outOfTime(ctx, decideBy)) {
          decideStopped = true;
          break;
        }
        order.push(workspaceId);
        let days: number | undefined;
        try {
          days = daysLimit(await deps.entitlements.get(workspaceId), 'audit_log_days');
        } catch (err) {
          skip(workspaceId, 'entitlements_failed', err);
          continue;
        }
        if (days === undefined) {
          skip(workspaceId, 'entitlements_unavailable');
          continue;
        }
        const state = await deps.state.get(workspaceId, 'audit');
        const decision = decideRetention(state, days, ctx.now, { requireNotice: false });
        const before = daysBefore(ctx.now, decision.enforceDays);
        const workspaceDue = await deps.store.dueEvents(workspaceId, before);
        plan.set(workspaceId, { decision, state, before, due: workspaceDue });
        due += workspaceDue;
        if (
          decision.enforceDays === 0 &&
          state.pending === null &&
          (state.baseline === 0 ||
            (state.baseline === null &&
              (await deps.store.dueEvents(workspaceId, daysBefore(ctx.now, FRESH_DAYS))) === 0))
        ) {
          unguarded += workspaceDue;
        }
      }
      // `unguarded` is exact, the total may be the planner's estimate (a large table): when the
      // estimate leaves the guarded workspaces fewer events than they have due, it is too low to
      // subtract from, and the guarded events are compared with the whole table.
      const total = await deps.store.totalEvents();
      const guardedDue = due - unguarded;
      guardFraction(ctx, guardedDue, total - unguarded >= guardedDue ? total - unguarded : total);
      if (ctx.dryRun) {
        return {
          scanned: due,
          purged: 0,
          skipped: 0,
          ...(decideStopped ? { stopped: 'budget_exceeded' as const } : {}),
        };
      }

      // Pass 2: record and delete, in the same order, with the rest of the budget.
      let purged = 0;
      let actStopped = false;
      let lastDone: string | null = null;
      for (const workspaceId of order) {
        const entry = plan.get(workspaceId);
        if (entry !== undefined) {
          if (outOfTime(ctx, deadline)) {
            actStopped = true;
            break;
          }
          await recordDecision(deps.state, workspaceId, 'audit', entry.decision, entry.state);
          while (entry.due > 0) {
            if (outOfTime(ctx, deadline)) {
              actStopped = true;
              break;
            }
            const deleted = await deps.store.purge(workspaceId, entry.before, ROW_BATCH);
            purged += deleted;
            if (deleted < ROW_BATCH) break;
          }
          if (actStopped) break;
        }
        lastDone = workspaceId;
      }
      const stopped = decideStopped || actStopped;
      if (!stopped) await writeCursor(deps.cursor, 'audit', null, deps.logger);
      else if (lastDone !== null) await writeCursor(deps.cursor, 'audit', lastDone, deps.logger);
      if (stopped) {
        return {
          scanned: due,
          purged,
          skipped: 0,
          backlog: Math.max(0, due - purged),
          stopped: 'budget_exceeded',
        };
      }
      return { scanned: due, purged, skipped: 0 };
    },
  };
}
