/**
 * History retention (B090, CT-RESUME "Deletion and retention", CT-ENTITLEMENTS): after a session
 * ends, its durable log (and snapshots, once B056 stores them) is kept for the workspace's
 * effective `history_days`, then purged through B055's history store (blobs first, then the index
 * and retention rows, so no metadata outlives a blob that failed to go).
 *
 * A run, in two passes over the workspaces with ended sessions holding history, in id order from
 * where the last run stopped (cursor.ts):
 *
 * 1. **Decide** (no writes), until DECIDE_SHARE of the budget is spent: for each workspace, read
 *    its entitlements (B069) and retention override, decide what to enforce (effective.ts: a
 *    shortened retention keeps the old days for 7 days after its notice) and count the frames
 *    due. A workspace whose entitlements cannot be read is skipped this run (never taken for 0
 *    days), with a warning. Then the fraction brake over every frame stored, for the workspaces
 *    decided.
 * 2. **Act**, with the rest of the budget: write each decided workspace's decision (baseline,
 *    pending shortening), send what a pending shortening still owes (the notice to live sessions,
 *    the owners' email; each marked once sent, with the time it went out, so it goes out once),
 *    and purge the due sessions, page by page, HISTORY_CONCURRENCY at a time (a session holding
 *    only a retention row or unindexed blobs is purged too). A blob store that throttles (HTTP 429
 *    or 503) halves the concurrency and the session is retried after a backoff; any other failure
 *    leaves the session for the next run.
 *
 * A spent budget stops cleanly between workspaces, pages and purge rounds and reports the frames
 * decided and left as backlog. The cursor then records the last workspace finished, so the next
 * run continues after it (and wraps around); a run that went all the way round clears it.
 *
 * Only sessions that `ended` or `expired` (with an end time) are ever purged: `pending`, `live`
 * and `paused` ones never, whatever their age; sessions outside any workspace are left alone (no
 * entitlements to measure them by).
 *
 * Owns: these rules. Must not: read blob contents, or log session ids (counts and workspace ids
 * only).
 */
import { noopMetrics, type Logger, type Metrics, type PubSub } from '@centcom/core';
import {
  decideRetention,
  effectiveHistoryDays,
  purgeHorizon,
  recordDecision,
  type PendingShortening,
  type RetentionDecision,
  type RetentionState,
  type RetentionStateStore,
} from './effective.js';
import { HISTORY_RETENTION_TEMPLATE_ID, publishRetentionNotice } from './notice.js';
import { readCursor, workspacesFrom, writeCursor, type DecideCursor } from './cursor.js';
import {
  deadlineOf,
  decideDeadlineOf,
  guardFraction,
  outOfTime,
  type RetentionContext,
  type RetentionPolicy,
  type RetentionResult,
} from './policy.js';

/** Sessions purged at once at most (each deletes its blobs one at a time). */
export const HISTORY_CONCURRENCY = 4;
/** Sessions read per page. */
export const HISTORY_SESSION_PAGE = 100;
/** Workspaces read per page. */
export const HISTORY_WORKSPACE_PAGE = 500;
/** Retries of a session whose blob store throttled, within one run. */
export const THROTTLE_RETRIES = 3;
/** The first wait after a throttled delete; each later one doubles (with jitter). */
export const THROTTLE_BACKOFF_MS = 1_000;

/** A session past its retention, and the frames it holds. */
export interface DueSession {
  sessionId: string;
  frames: number;
}

/** What the history policy reads in Postgres. */
export interface HistoryRetentionStore {
  /** Up to `limit` workspaces, by id after `after`, with ended sessions that hold history. */
  workspacesWithHistory(after: string | null, limit: number): Promise<string[]>;
  /** The workspace's retention override (`retention_days`), or null. */
  retentionOverride(workspaceId: string): Promise<number | null>;
  /** Frames of the workspace's ended sessions that ended at or before `endedBy`. */
  dueFrames(workspaceId: string, endedBy: Date): Promise<number>;
  /** Up to `limit` of those sessions (any holding history), by id after `after`. */
  dueSessions(
    workspaceId: string,
    endedBy: Date,
    after: string | null,
    limit: number,
  ): Promise<DueSession[]>;
  /** Every frame stored, of every session (exact or a close estimate on a large table). */
  totalFrames(): Promise<number>;
  /** The workspace's name and its active owners' addresses; null when it is gone. */
  owners(workspaceId: string): Promise<{ workspaceName: string; emails: string[] } | null>;
}

/** Purges one session's blobs and rows (B055's `HistoryStore.purge`; B056's snapshots later). */
export interface SessionBlobPurger {
  purge(sessionId: string): Promise<{ deleted: number; blobs: number }>;
}

/** B069's entitlements, as retention reads them. */
export interface RetentionEntitlementsReader {
  get(workspaceId: string): Promise<{ limits: Record<string, unknown> } | null>;
}

/** B032's email service, as retention sends with it. */
export interface RetentionMailer {
  send(
    id: typeof HISTORY_RETENTION_TEMPLATE_ID,
    to: string,
    params: { workspaceName: string; days: string; effectiveAt: Date },
    opts: { idempotencyKey: string },
  ): Promise<unknown>;
}

/** What the history policy needs. */
export interface HistoryPolicyDeps {
  store: HistoryRetentionStore;
  /** The bookkeeping (enforced days, pending shortenings). */
  state: RetentionStateStore;
  /** Where the next run continues. */
  cursor: DecideCursor;
  history: SessionBlobPurger;
  /** B056's snapshot store, once it exists. */
  snapshots?: SessionBlobPurger;
  entitlements: RetentionEntitlementsReader;
  notices: Pick<PubSub, 'publish'>;
  mailer: RetentionMailer;
  /** Waits between throttled retries (tests pass a fake); default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 for the backoff's jitter; default Math.random. */
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The workspace's `limits[name]` when it is a whole number of days, else undefined. */
export function daysLimit(
  ent: { limits: Record<string, unknown> } | null,
  name: string,
): number | undefined {
  const value = ent?.limits[name];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** True for a blob store's throttling answer (B055's BlobStoreError for HTTP 429 or 503). */
export function isThrottled(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'BlobStoreError' &&
    /answered (429|503)\b/.test(err.message)
  );
}

const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

/** What pass 1 decided for a workspace. */
interface Decided {
  decision: RetentionDecision;
  state: RetentionState;
  due: number;
}

/** The history policy. */
export function createHistoryPolicy(deps: HistoryPolicyDeps): RetentionPolicy {
  const metrics = deps.metrics ?? noopMetrics;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  const skipWorkspace = (workspaceId: string, reason: string, err?: unknown): void => {
    metrics.counter('retention_workspaces_skipped_total', { policy: 'history', reason }).inc();
    deps.logger?.warn(
      {
        workspace_id: workspaceId,
        reason,
        ...(err === undefined ? {} : { error: errorKind(err) }),
      },
      'retention.workspace_skipped',
    );
  };

  /** Pass 1 for one workspace: today's decision and the frames due, or null to skip it. */
  async function decide(workspaceId: string, now: Date): Promise<Decided | null> {
    let planDays: number | undefined;
    try {
      planDays = daysLimit(await deps.entitlements.get(workspaceId), 'history_days');
    } catch (err) {
      skipWorkspace(workspaceId, 'entitlements_failed', err);
      return null;
    }
    if (planDays === undefined) {
      skipWorkspace(workspaceId, 'entitlements_unavailable');
      return null;
    }
    const effective = effectiveHistoryDays(
      planDays,
      await deps.store.retentionOverride(workspaceId),
    );
    const state = await deps.state.get(workspaceId, 'history');
    const decision = decideRetention(state, effective, now, { requireNotice: true });
    const due = await deps.store.dueFrames(workspaceId, purgeHorizon(now, decision.enforceDays));
    return { decision, state, due };
  }

  /** Writes the decision (logged); the pending shortening after it, if any. */
  async function record(workspaceId: string, decided: Decided): Promise<PendingShortening | null> {
    const pending = await recordDecision(
      deps.state,
      workspaceId,
      'history',
      decided.decision,
      decided.state,
    );
    const { change } = decided.decision;
    if (change.kind === 'announce') {
      deps.logger?.info(
        { workspace_id: workspaceId, days: change.pending.newDays },
        'retention.shortening_announced',
      );
    } else if (change.kind === 'withdraw' || change.kind === 'apply') {
      deps.logger?.info(
        { workspace_id: workspaceId, days: change.days },
        change.kind === 'withdraw'
          ? 'retention.shortening_withdrawn'
          : 'retention.shortening_applied',
      );
    }
    return pending;
  }

  /**
   * Sends what a pending shortening still owes; failures are retried next run. Each is marked
   * with the time it went out (the wall clock, not the run's start), which the 7 days count from.
   */
  async function tell(
    workspaceId: string,
    pending: PendingShortening,
    clock: () => number,
  ): Promise<void> {
    if (pending.noticeSentAt === null) {
      try {
        await publishRetentionNotice(deps.notices, workspaceId, pending.newDays);
        await deps.state.markSent(workspaceId, 'history', 'notice', new Date(clock()));
      } catch (err) {
        metrics.counter('retention_notice_failures_total', { step: 'notice' }).inc();
        deps.logger?.warn(
          { workspace_id: workspaceId, step: 'notice', error: errorKind(err) },
          'retention.notice_failed',
        );
      }
    }
    if (pending.emailSentAt === null) {
      try {
        const owners = await deps.store.owners(workspaceId);
        for (const to of owners?.emails ?? []) {
          await deps.mailer.send(
            HISTORY_RETENTION_TEMPLATE_ID,
            to,
            {
              workspaceName: owners?.workspaceName ?? '',
              days: String(pending.newDays),
              effectiveAt: pending.effectiveAt,
            },
            // One per shortening and owner (the service scopes keys by template and recipient).
            { idempotencyKey: `retention:${workspaceId}:${pending.effectiveAt.getTime()}` },
          );
        }
        await deps.state.markSent(workspaceId, 'history', 'email', new Date(clock()));
      } catch (err) {
        metrics.counter('retention_notice_failures_total', { step: 'email' }).inc();
        deps.logger?.warn(
          { workspace_id: workspaceId, step: 'email', error: errorKind(err) },
          'retention.notice_failed',
        );
      }
    }
  }

  /** Purges one session (snapshots, then history); its frames deleted. */
  async function purgeSession(sessionId: string): Promise<number> {
    if (deps.snapshots !== undefined) await deps.snapshots.purge(sessionId);
    return (await deps.history.purge(sessionId)).deleted;
  }

  /**
   * Purges `sessions`, `concurrency.value` at a time: a throttled one halves the concurrency and
   * comes back after a backoff (THROTTLE_RETRIES times at most); any other failure skips it.
   * Stops between rounds once `stop()` says so: `stopped` when it left sessions it did not get to
   * (whether or not they hold frames).
   */
  async function purgeSessions(
    sessions: readonly DueSession[],
    concurrency: { value: number },
    stop: () => boolean,
  ): Promise<{ purged: number; skipped: number; handled: number; stopped: boolean }> {
    let purged = 0;
    let skipped = 0;
    let handled = 0;
    let queue = sessions.map((s) => ({ ...s, attempt: 0 }));
    while (queue.length > 0) {
      if (stop()) break;
      const round = queue.slice(0, concurrency.value);
      queue = queue.slice(round.length);
      const results = await Promise.allSettled(round.map((s) => purgeSession(s.sessionId)));
      let throttled = 0;
      results.forEach((result, i) => {
        const session = round[i];
        if (session === undefined) return;
        if (result.status === 'fulfilled') {
          purged += result.value;
          handled += session.frames;
          return;
        }
        if (isThrottled(result.reason) && session.attempt < THROTTLE_RETRIES) {
          throttled += 1;
          queue.push({ ...session, attempt: session.attempt + 1 });
          return;
        }
        skipped += session.frames;
        handled += session.frames;
        metrics.counter('retention_purge_failures_total', { policy: 'history' }).inc();
        deps.logger?.warn(
          { policy: 'history', error: errorKind(result.reason) },
          'retention.purge_failed',
        );
      });
      if (throttled > 0) {
        concurrency.value = Math.max(1, Math.floor(concurrency.value / 2));
        metrics.counter('retention_throttled_total', { policy: 'history' }).inc(throttled);
        const attempt = Math.max(...round.map((s) => s.attempt));
        await sleep(THROTTLE_BACKOFF_MS * 2 ** attempt * (0.5 + random() / 2));
      } else if (concurrency.value < HISTORY_CONCURRENCY) {
        concurrency.value += 1;
      }
    }
    return { purged, skipped, handled, stopped: queue.length > 0 };
  }

  /**
   * Pass 2 for one workspace: records its decision, sends what is owed and purges its due
   * sessions; false when the budget ran out before it was done.
   */
  async function act(
    ctx: RetentionContext,
    workspaceId: string,
    decided: Decided,
    concurrency: { value: number },
    late: () => boolean,
    counts: { purged: number; skipped: number; handled: number },
  ): Promise<boolean> {
    const pending = await record(workspaceId, decided);
    if (pending !== null) await tell(workspaceId, pending, ctx.clock);
    const endedBy = purgeHorizon(ctx.now, decided.decision.enforceDays);
    let cursor: string | null = null;
    for (;;) {
      if (late()) return false;
      const sessions = await deps.store.dueSessions(
        workspaceId,
        endedBy,
        cursor,
        HISTORY_SESSION_PAGE,
      );
      if (sessions.length === 0) return true;
      const done = await purgeSessions(sessions, concurrency, late);
      counts.purged += done.purged;
      counts.skipped += done.skipped;
      counts.handled += done.handled;
      if (done.stopped) return false;
      if (sessions.length < HISTORY_SESSION_PAGE) return true;
      cursor = sessions.at(-1)?.sessionId ?? null;
    }
  }

  return {
    id: 'history',
    owner: 'B055',
    async run(ctx: RetentionContext): Promise<RetentionResult> {
      const started = ctx.clock();
      const deadline = deadlineOf(ctx, started);
      const decideBy = decideDeadlineOf(ctx, started);
      const late = () => outOfTime(ctx, deadline);
      const start = await readCursor(deps.cursor, 'history', deps.logger);

      // Pass 1: decide, from the cursor, until DECIDE_SHARE of the budget is spent.
      const order: string[] = [];
      const plan = new Map<string, Decided>();
      let due = 0;
      let decideStopped = false;
      const workspaces = workspacesFrom(
        (after, limit) => deps.store.workspacesWithHistory(after, limit),
        start,
        HISTORY_WORKSPACE_PAGE,
      );
      for await (const workspaceId of workspaces) {
        if (outOfTime(ctx, decideBy)) {
          // The rest wait for the next run, which starts after the last workspace finished.
          decideStopped = true;
          break;
        }
        order.push(workspaceId);
        const decided = await decide(workspaceId, ctx.now);
        if (decided === null) continue;
        plan.set(workspaceId, decided);
        due += decided.due;
      }
      guardFraction(ctx, due, await deps.store.totalFrames());
      if (ctx.dryRun) {
        deps.logger?.info(
          { policy: 'history', workspaces: plan.size, frames: due, dry_run: true },
          'retention.history_counted',
        );
        return {
          scanned: due,
          purged: 0,
          skipped: 0,
          ...(decideStopped ? { stopped: 'budget_exceeded' as const } : {}),
        };
      }

      // Pass 2: act on the workspaces decided, in the same order, with the rest of the budget.
      const counts = { purged: 0, skipped: 0, handled: 0 };
      const concurrency = { value: HISTORY_CONCURRENCY };
      let actStopped = false;
      let lastDone: string | null = null;
      for (const workspaceId of order) {
        const decided = plan.get(workspaceId);
        if (decided !== undefined) {
          if (late() || !(await act(ctx, workspaceId, decided, concurrency, late, counts))) {
            actStopped = true;
            break;
          }
        }
        lastDone = workspaceId;
      }
      const stopped = decideStopped || actStopped;
      // All the way round: the next run starts at the first id. Stopped: after the last workspace
      // finished (where this run started, when it finished none).
      if (!stopped) await writeCursor(deps.cursor, 'history', null, deps.logger);
      else if (lastDone !== null) await writeCursor(deps.cursor, 'history', lastDone, deps.logger);
      deps.logger?.info(
        {
          policy: 'history',
          workspaces: plan.size,
          frames: counts.purged,
          skipped: counts.skipped,
        },
        'retention.history_purged',
      );
      if (stopped) {
        return {
          scanned: due,
          purged: counts.purged,
          skipped: counts.skipped,
          backlog: Math.max(0, due - counts.handled),
          stopped: 'budget_exceeded',
        };
      }
      return { scanned: due, purged: counts.purged, skipped: counts.skipped };
    },
  };
}
