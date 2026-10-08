/**
 * The `account-purge` queue (B026, CT-API-ACCOUNTS): the end of an account's 30-day grace period.
 *
 * - `purge` jobs are delayed until the deadline, with job id `purge-<usr>` (BullMQ rejects ":" in
 *   custom ids, so the card's `purge:<usr>` is spelled with "-"): one per user, and adding it again
 *   while it exists does nothing. `cancelAccountPurge` removes it when the deletion is cancelled;
 *   if it still fires, the API's `purgeUser` (injected as `purge`) finds nothing due and does
 *   nothing.
 * - `waiting` (the user's own workspaces are still being purged) is retried: the processor throws
 *   and BullMQ waits, exponentially from 1 minute with 50 % jitter, up to 10 attempts. So is any
 *   failure; after the last attempt the job is dead-lettered (kept 7 days), counted in
 *   `account_purge_failed_total` and logged, and the user stays scheduled.
 * - `sweep`, every hour: queues a purge for every user whose deadline has passed, so a purge that
 *   was never queued (Redis down when the deletion was requested) still runs.
 *
 * Owns: the queue, the schedule and the worker. Must not: log anything but ids and outcomes.
 */
import { isId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B026). */
export const ACCOUNT_PURGE_QUEUE = 'account-purge';
/** The job that purges one account. */
export const ACCOUNT_PURGE_JOB = 'purge';
/** The job that queues purges whose deadline has passed. */
export const ACCOUNT_PURGE_SWEEP_JOB = 'sweep';
/** Attempts per purge, the first included. */
export const ACCOUNT_PURGE_ATTEMPTS = 10;
/** The first retry waits about this long; each later one about twice as long. */
export const ACCOUNT_PURGE_BACKOFF_MS = 60_000;
/** The share of each wait that is random. */
export const ACCOUNT_PURGE_JITTER = 0.5;
/** Dead-lettered jobs are kept this long, in seconds (7 days). */
export const ACCOUNT_PURGE_FAILED_RETENTION_S = 7 * 24 * 60 * 60;
/** How often the sweep runs. */
export const ACCOUNT_PURGE_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** The id of the sweep's schedule. */
export const ACCOUNT_PURGE_SWEEP_SCHEDULER_ID = 'account-purge-sweep-every-hour';
/** Purges one sweep queues at most (the next sweep takes the rest). */
export const ACCOUNT_PURGE_SWEEP_BATCH = 500;

/** The purge job of `userId`. */
export const accountPurgeJobId = (userId: string): string => `purge-${userId}`;

/** A purge job's data. */
export interface AccountPurgeJobData {
  userId: string;
}

/** What `purgeUser` reported (the API's PurgeOutcome). */
export type AccountPurgeOutcome =
  'deleted' | 'scrubbed' | 'waiting' | 'blocked' | 'cancelled' | 'not_due' | 'gone';

/** The purge waits for the user's own workspaces to be purged; BullMQ retries it. */
export class AccountPurgeWaitingError extends Error {
  override name = 'AccountPurgeWaitingError';
}

/** The options every purge job carries. */
export function accountPurgeJobOptions() {
  return {
    attempts: ACCOUNT_PURGE_ATTEMPTS,
    backoff: {
      type: 'exponential' as const,
      delay: ACCOUNT_PURGE_BACKOFF_MS,
      jitter: ACCOUNT_PURGE_JITTER,
    },
    removeOnComplete: true as const,
    removeOnFail: { age: ACCOUNT_PURGE_FAILED_RETENTION_S },
  };
}

/** Somewhere to add and remove jobs. */
export type AccountPurgeQueueLike = Pick<Queue, 'add'>;

/** Queues the purge of `userId` to run at `at` (now when it has passed). */
export async function scheduleAccountPurge(
  queue: AccountPurgeQueueLike,
  userId: string,
  at: Date,
  now: Date = new Date(),
): Promise<void> {
  await queue.add(
    ACCOUNT_PURGE_JOB,
    { userId },
    {
      ...accountPurgeJobOptions(),
      jobId: accountPurgeJobId(userId),
      delay: Math.max(0, at.getTime() - now.getTime()),
    },
  );
}

/** Removes the delayed purge of `userId`; nothing when there is none (or it is running). */
export async function cancelAccountPurge(
  queue: Pick<Queue, 'remove'>,
  userId: string,
): Promise<void> {
  await queue.remove(accountPurgeJobId(userId));
}

/** What the processor needs: the API's purge. */
export interface AccountPurgeDeps {
  /** `purgeUser(deps, userId)`. */
  purge(userId: string): Promise<AccountPurgeOutcome>;
  /** Users whose deadline is at or before `now`, at most `limit` (for the sweep). */
  due(now: Date, limit: number): Promise<string[]>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `account_purge_failed_total`. */
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type AccountPurgeJob = Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade'>;

/** Runs one job: a purge (throwing while it waits), or a sweep that queues due purges. */
export async function processAccountPurge(
  job: AccountPurgeJob,
  deps: AccountPurgeDeps,
  queue: AccountPurgeQueueLike,
): Promise<string> {
  const now = new Date((deps.clock ?? Date.now)());
  if (job.name === ACCOUNT_PURGE_SWEEP_JOB) {
    const due = await deps.due(now, ACCOUNT_PURGE_SWEEP_BATCH);
    for (const userId of due) await scheduleAccountPurge(queue, userId, now, now);
    if (due.length > 0) deps.logger?.info({ queued: due.length }, 'account_purge.swept');
    return 'swept';
  }
  const userId = (job.data as Partial<AccountPurgeJobData> | null)?.userId;
  if (!isId('usr', userId)) throw new UnrecoverableError('account-purge: bad job data');
  const outcome = await deps.purge(userId);
  if (outcome === 'waiting') {
    throw new AccountPurgeWaitingError('account-purge: waiting for workspace purges');
  }
  return outcome;
}

/** Where BullMQ keeps the queue. */
export interface AccountPurgeQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `account-purge` queue (the API's `AccountJobs.schedulePurge` and `cancelPurge`). */
export function createAccountPurgeQueue(options: AccountPurgeQueueOptions): Queue {
  return new Queue(ACCOUNT_PURGE_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: accountPurgeJobOptions(),
  });
}

/** Makes the sweep run every hour (idempotent: one schedule per queue). */
export async function scheduleAccountPurgeSweep(queue: Pick<Queue, 'upsertJobScheduler'>) {
  await queue.upsertJobScheduler(
    ACCOUNT_PURGE_SWEEP_SCHEDULER_ID,
    { every: ACCOUNT_PURGE_SWEEP_EVERY_MS },
    {
      name: ACCOUNT_PURGE_SWEEP_JOB,
      opts: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: ACCOUNT_PURGE_FAILED_RETENTION_S },
      },
    },
  );
}

/** After a failed attempt: logs a retry, or counts and logs the job once it is dead-lettered. */
export function onAccountPurgeFailed(
  job: Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<AccountPurgeDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  const userId = (job.data as Partial<AccountPurgeJobData> | null)?.userId;
  const fields = {
    user_id: isId('usr', userId) ? userId : 'invalid',
    job_id: job.id ?? 'unknown',
    attempts: job.attemptsMade,
    error: err.name,
  };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? ACCOUNT_PURGE_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'account_purge.retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('account_purge_failed_total').inc();
  deps.logger?.error(fields, 'account_purge.failed');
}

/** Options for `startAccountPurgeWorker`. */
export interface AccountPurgeWorkerOptions extends AccountPurgeQueueOptions, AccountPurgeDeps {
  /** Where the sweep queues due purges; the worker's own queue. */
  queue: AccountPurgeQueueLike;
  /** Jobs processed at once; default 2. */
  concurrency?: number;
}

/** Starts a worker on the `account-purge` queue. Close it with `worker.close()`. */
export function startAccountPurgeWorker(options: AccountPurgeWorkerOptions): Worker {
  const worker = new Worker(
    ACCOUNT_PURGE_QUEUE,
    (job: Job<unknown>) => processAccountPurge(job, options, options.queue),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: options.concurrency ?? 2,
    },
  );
  worker.on('failed', (job, err) => onAccountPurgeFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'account_purge.worker_error'),
  );
  return worker;
}
