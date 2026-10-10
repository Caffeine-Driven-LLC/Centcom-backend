/**
 * The `retention` queue (B090): nightly, idempotent purges of every dataset past its retention,
 * and the immediate purge of a deleted workspace.
 *
 * - **`run {policy?}`**: the runner (runner.ts) over the policies (policies.ts), or over one
 *   policy. Scheduled daily at 03:00 UTC (one schedule per queue). A run in which a policy failed
 *   or found its lock taken fails after the others ran, so BullMQ retries it (5 attempts,
 *   exponential backoff from 3 minutes with jitter, so even the first retry, 90 s or more later,
 *   comes after a dead worker's 60 s lock has expired); the
 *   policies are idempotent, so a retry only finishes what is left. A brake or a spent budget is
 *   not a failure: it is reported, and the next night continues.
 * - **`purge-workspace {workspaceId}`**: `purgeWorkspace` (purge-workspace.ts); 5 attempts,
 *   backoff from 10 s. B027's purge job runs the same purge as its `retention` hook.
 *
 * Runs that failed every attempt stay in the queue's failed set (the dead-letter set, kept 7
 * days), counted and logged by error kind.
 *
 * Owns: the queue, the schedule, the processor and the worker. Must not: purge anything itself.
 */
import { isId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  Queue,
  UnrecoverableError,
  Worker,
  type BackoffOptions,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import type { WorkspacePurger } from './purge-workspace.js';
import type { PolicyReport, RetentionRunner } from './runner.js';

/** The queue's name (card B090: jobs `retention.run` and `retention.purge-workspace`). */
export const RETENTION_QUEUE = 'retention';
export const RETENTION_RUN_JOB = 'run';
export const RETENTION_PURGE_WORKSPACE_JOB = 'purge-workspace';
/** The nightly schedule: 03:00 UTC. */
export const RETENTION_SCHEDULER_ID = 'retention-run-nightly';
export const RETENTION_RUN_PATTERN = '0 3 * * *';
/** Attempts per job, the first included. */
export const RETENTION_ATTEMPTS = 5;
/** A run's first retry waits between half and all of this; each later one twice as long. */
export const RETENTION_RUN_BACKOFF_MS = 3 * 60 * 1000;
/** A workspace purge's first retry waits between half and all of this. */
export const RETENTION_PURGE_BACKOFF_MS = 10_000;
/** Dead-lettered jobs are kept this long, in seconds (7 days). */
export const RETENTION_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

const POLICY_ID = /^[a-z][a-z0-9_]{0,39}$/;

/** The options a job carries; `delay` is the first retry's base wait. */
export function retentionJobOptions(delay: number = RETENTION_RUN_BACKOFF_MS): {
  attempts: number;
  backoff: BackoffOptions;
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: RETENTION_ATTEMPTS,
    backoff: { type: 'exponential', delay, jitter: 0.5 },
    removeOnComplete: true,
    removeOnFail: { age: RETENTION_FAILED_RETENTION_S },
  };
}

/** A run that left work behind for a retry: a policy failed or was locked. */
export class RetentionRunIncomplete extends Error {
  override name = 'RetentionRunIncomplete';
  constructor(readonly policies: string[]) {
    super(`retention policies left for a retry: ${policies.join(', ')}`);
  }
}

/** What the processor needs. */
export interface RetentionJobDeps {
  runner: Pick<RetentionRunner, 'run'>;
  purger: WorkspacePurger;
  logger?: Logger;
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type RetentionJob = Pick<Job<unknown>, 'name' | 'data'>;

/** Runs one job. */
export async function processRetention(
  job: RetentionJob,
  deps: RetentionJobDeps,
): Promise<PolicyReport[] | { blobs: number; rows: number }> {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (job.name === RETENTION_RUN_JOB) {
    const policy = data['policy'];
    if (policy !== undefined && (typeof policy !== 'string' || !POLICY_ID.test(policy))) {
      throw new UnrecoverableError('retention: policy must be a policy id');
    }
    let reports: PolicyReport[];
    try {
      reports = await deps.runner.run(policy === undefined ? {} : { policy });
    } catch (err) {
      // An unknown policy: retrying will not make it known.
      if (err instanceof TypeError) throw new UnrecoverableError(err.message);
      throw err;
    }
    const left = reports
      .filter((r) => r.outcome === 'failed' || r.outcome === 'locked')
      .map((r) => r.policy);
    if (left.length > 0) throw new RetentionRunIncomplete(left);
    return reports;
  }
  if (job.name === RETENTION_PURGE_WORKSPACE_JOB) {
    const workspaceId = data['workspaceId'];
    if (!isId('wsp', workspaceId)) {
      throw new UnrecoverableError('retention: purge-workspace needs a wsp_ workspaceId');
    }
    return deps.purger.purgeWorkspace(workspaceId);
  }
  throw new UnrecoverableError('retention: unknown job');
}

/** Where BullMQ keeps the queue. */
export interface RetentionQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `retention` queue. */
export function createRetentionQueue(options: RetentionQueueOptions): Queue {
  return new Queue(RETENTION_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: retentionJobOptions(),
  });
}

/** Schedules the nightly run (idempotent: one schedule per queue). */
export async function scheduleRetention(queue: Pick<Queue, 'upsertJobScheduler'>): Promise<void> {
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { pattern: RETENTION_RUN_PATTERN, tz: 'UTC' },
    { name: RETENTION_RUN_JOB, data: {}, opts: retentionJobOptions() },
  );
}

/** Queues the immediate purge of a deleted workspace (job id per workspace: queued once). */
export async function enqueueWorkspaceRetentionPurge(
  queue: Pick<Queue, 'add'>,
  workspaceId: string,
): Promise<void> {
  if (!isId('wsp', workspaceId)) throw new TypeError('workspaceId must be a wsp_ id');
  await queue.add(
    RETENTION_PURGE_WORKSPACE_JOB,
    { workspaceId },
    {
      ...retentionJobOptions(RETENTION_PURGE_BACKOFF_MS),
      jobId: `purge-workspace-${workspaceId}`,
    },
  );
}

/** Options for `startRetentionWorker`. */
export interface RetentionWorkerOptions extends RetentionQueueOptions, RetentionJobDeps {}

/** Starts a worker on the queue (one job at a time). */
export function startRetentionWorker(options: RetentionWorkerOptions): Worker {
  const metrics = options.metrics ?? noopMetrics;
  const worker = new Worker(
    RETENTION_QUEUE,
    (job: Job<unknown>) => processRetention(job, options),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) => {
    const attempts = job?.attemptsMade ?? 0;
    const last = err instanceof UnrecoverableError || attempts >= RETENTION_ATTEMPTS;
    // The error's kind only: its text can name the database host.
    const fields = { job: job?.name ?? 'unknown', attempts, error: err.name };
    if (!last) {
      options.logger?.warn(fields, 'retention.job_retry');
      return;
    }
    metrics.counter('retention_jobs_failed_total', { job: job?.name ?? 'unknown' }).inc();
    options.logger?.error(fields, 'retention.job_failed');
  });
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'retention.worker_error'));
  return worker;
}

export { loadRetentionConfig, retentionEnvSchema } from './config.js';
export {
  createAuditPolicy,
  AUDIT_WORKSPACE_PAGE,
  FRESH_DAYS,
  type AuditPolicyDeps,
  type AuditRetentionStore,
} from './audit.js';
export {
  createDecideCursor,
  readCursor,
  RETENTION_CURSOR_TTL_MS,
  retentionCursorKey,
  workspacesFrom,
  writeCursor,
  type DecideCursor,
} from './cursor.js';
export {
  APPLY_TOLERANCE_MS,
  applicableAt,
  decideRetention,
  DOWNGRADE_NOTICE_MS,
  effectiveHistoryDays,
  purgeHorizon,
  recordDecision,
  type DecideOptions,
  type PendingShortening,
  type RetentionChange,
  type RetentionDataset,
  type RetentionDecision,
  type RetentionState,
  type RetentionStateStore,
} from './effective.js';
export {
  createHistoryPolicy,
  daysLimit,
  HISTORY_CONCURRENCY,
  HISTORY_SESSION_PAGE,
  HISTORY_WORKSPACE_PAGE,
  isThrottled,
  THROTTLE_BACKOFF_MS,
  THROTTLE_RETRIES,
  type DueSession,
  type HistoryPolicyDeps,
  type HistoryRetentionStore,
  type RetentionEntitlementsReader,
  type RetentionMailer,
  type SessionBlobPurger,
} from './history.js';
export {
  createPolicyLock,
  RETENTION_LOCK_RENEW_MS,
  RETENTION_LOCK_TTL_MS,
  retentionLockKey,
  type HeldLock,
  type PolicyLock,
} from './lock.js';
export {
  HISTORY_RETENTION_TEMPLATE,
  HISTORY_RETENTION_TEMPLATE_ID,
  publishRetentionNotice,
  registerRetentionTemplates,
  retentionNoticeChannel,
  retentionNoticeOf,
  type RetentionNotice,
} from './notice.js';
export {
  createRetentionPolicies,
  ROW_POLICIES,
  type RetentionPoliciesDeps,
  type RetentionStores,
  type RowPolicyId,
} from './policies.js';
export {
  DECIDE_SHARE,
  DEFAULT_MAX_DELETE_FRACTION,
  daysBefore,
  decideDeadlineOf,
  guardFraction,
  RetentionAbort,
  ROW_BATCH,
  RUN_BUDGET_MS,
  type RetentionContext,
  type RetentionPolicy,
  type RetentionResult,
} from './policy.js';
export {
  createWorkspacePurger,
  registerRetentionPurgeHook,
  RETENTION_PURGE_HOOK,
  type WorkspacePurger,
  type WorkspacePurgerDeps,
  type WorkspaceSessionsReader,
} from './purge-workspace.js';
export { createRowPolicy, type RowPolicyOptions, type RowRetentionStore } from './rows.js';
export {
  createTelemetryReportPolicy,
  TELEMETRY_RAW_DAYS,
  type TelemetryReportStore,
} from './telemetry.js';
export {
  observeRetentionBacklog,
  RetentionRunner,
  RUN_DURATION_BUCKETS_S,
  type PolicyReport,
  type RetentionAbortReason,
  type RetentionRunConfig,
  type RetentionRunnerDeps,
  type RetentionRunStore,
} from './runner.js';
