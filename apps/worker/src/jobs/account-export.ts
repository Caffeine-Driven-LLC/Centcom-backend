/**
 * The `account-export` queue (B026, CT-API-ACCOUNTS): users' data exports, and the sweep that
 * expires them.
 *
 * - `export` jobs (job id the `exp_` id, so one export is queued once): the API's
 *   `AccountExportRunner.run`, injected as `run`, told whether this is the last of the 5 attempts
 *   (exponential backoff from 10 s with 50 % jitter); the runner marks the export failed and
 *   removes any file on the last one. Dead-lettered jobs are kept 7 days.
 * - `sweep`, every 15 minutes (one schedule per queue): `AccountExportRunner.sweep` deletes the
 *   files of exports past their 7 days and marks them expired, and the exports it finds still
 *   pending (their job was never queued) are queued again.
 *
 * Owns: the queue, the schedule and the worker. Must not: log an export's content or its URL.
 */
import { isId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B026). */
export const ACCOUNT_EXPORT_QUEUE = 'account-export';
/** The job that writes one export. */
export const ACCOUNT_EXPORT_JOB = 'export';
/** The job that expires files and requeues stuck exports. */
export const ACCOUNT_EXPORT_SWEEP_JOB = 'sweep';
/** Attempts per export, the first included (card B026). */
export const ACCOUNT_EXPORT_ATTEMPTS = 5;
/** The first retry waits about this long; each later one about twice as long. */
export const ACCOUNT_EXPORT_BACKOFF_MS = 10_000;
/** The share of each wait that is random. */
export const ACCOUNT_EXPORT_JITTER = 0.5;
/** Dead-lettered jobs are kept this long, in seconds (7 days). */
export const ACCOUNT_EXPORT_FAILED_RETENTION_S = 7 * 24 * 60 * 60;
/** How often the sweep runs. */
export const ACCOUNT_EXPORT_SWEEP_EVERY_MS = 15 * 60 * 1000;
/** The id of the sweep's schedule. */
export const ACCOUNT_EXPORT_SWEEP_SCHEDULER_ID = 'account-export-sweep-every-15-minutes';
/** Exports one worker writes at once. */
export const ACCOUNT_EXPORT_CONCURRENCY = 2;

/** An export job's data. */
export interface AccountExportJobData {
  exportId: string;
}

/** The options every export job carries. */
export function accountExportJobOptions() {
  return {
    attempts: ACCOUNT_EXPORT_ATTEMPTS,
    backoff: {
      type: 'exponential' as const,
      delay: ACCOUNT_EXPORT_BACKOFF_MS,
      jitter: ACCOUNT_EXPORT_JITTER,
    },
    removeOnComplete: true as const,
    removeOnFail: { age: ACCOUNT_EXPORT_FAILED_RETENTION_S },
  };
}

/** Somewhere to add jobs. */
export type AccountExportQueueLike = Pick<Queue, 'add'>;

/** Queues export `exportId` (the API's `AccountJobs.enqueueExport`). */
export async function enqueueAccountExport(
  queue: AccountExportQueueLike,
  exportId: string,
): Promise<void> {
  await queue.add(
    ACCOUNT_EXPORT_JOB,
    { exportId },
    { ...accountExportJobOptions(), jobId: exportId },
  );
}

/** What the processor needs: the API's export runner. */
export interface AccountExportDeps {
  /** `AccountExportRunner.run`. */
  run(exportId: string, opts: { finalAttempt: boolean }): Promise<'ready' | 'skipped'>;
  /** `AccountExportRunner.sweep`. */
  sweep(now: Date): Promise<{ expired: number; stale: string[] }>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `account_export_dead_letters_total{job}`. */
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type AccountExportJob = Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'>;

/** Runs one job: an export, or a sweep that queues the exports it finds stuck. */
export async function processAccountExport(
  job: AccountExportJob,
  deps: AccountExportDeps,
  queue: AccountExportQueueLike,
): Promise<string> {
  if (job.name === ACCOUNT_EXPORT_SWEEP_JOB) {
    const { expired, stale } = await deps.sweep(new Date((deps.clock ?? Date.now)()));
    for (const id of stale) await enqueueAccountExport(queue, id);
    if (expired > 0 || stale.length > 0) {
      deps.logger?.info({ expired, requeued: stale.length }, 'account_export.swept');
    }
    return 'swept';
  }
  const exportId = (job.data as Partial<AccountExportJobData> | null)?.exportId;
  if (!isId('exp', exportId)) throw new UnrecoverableError('account-export: bad job data');
  const attempts = job.opts.attempts ?? ACCOUNT_EXPORT_ATTEMPTS;
  return deps.run(exportId, { finalAttempt: job.attemptsMade + 1 >= attempts });
}

/** Where BullMQ keeps the queue. */
export interface AccountExportQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `account-export` queue. */
export function createAccountExportQueue(options: AccountExportQueueOptions): Queue {
  return new Queue(ACCOUNT_EXPORT_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: accountExportJobOptions(),
  });
}

/** Makes the sweep run every 15 minutes (idempotent: one schedule per queue). */
export async function scheduleAccountExportSweep(queue: Pick<Queue, 'upsertJobScheduler'>) {
  await queue.upsertJobScheduler(
    ACCOUNT_EXPORT_SWEEP_SCHEDULER_ID,
    { every: ACCOUNT_EXPORT_SWEEP_EVERY_MS },
    {
      name: ACCOUNT_EXPORT_SWEEP_JOB,
      opts: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: ACCOUNT_EXPORT_FAILED_RETENTION_S },
      },
    },
  );
}

/** After a failed attempt: logs a retry, or counts and logs the job once it is dead-lettered. */
export function onAccountExportFailed(
  job: Pick<Job<unknown>, 'id' | 'name' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<AccountExportDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  // The error's kind only: its text can name a host.
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? ACCOUNT_EXPORT_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'account_export.retry');
    return;
  }
  (deps.metrics ?? noopMetrics)
    .counter('account_export_dead_letters_total', { job: job.name })
    .inc();
  deps.logger?.warn(fields, 'account_export.dead_letter');
}

/** Options for `startAccountExportWorker`. */
export interface AccountExportWorkerOptions extends AccountExportQueueOptions, AccountExportDeps {
  /** Where the sweep queues stuck exports; the worker's own queue. */
  queue: AccountExportQueueLike;
  /** Default ACCOUNT_EXPORT_CONCURRENCY. */
  concurrency?: number;
}

/** Starts a worker on the `account-export` queue. Close it with `worker.close()`. */
export function startAccountExportWorker(options: AccountExportWorkerOptions): Worker {
  const worker = new Worker(
    ACCOUNT_EXPORT_QUEUE,
    (job: Job<unknown>) => processAccountExport(job, options, options.queue),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: options.concurrency ?? ACCOUNT_EXPORT_CONCURRENCY,
    },
  );
  worker.on('failed', (job, err) => onAccountExportFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'account_export.worker_error'),
  );
  return worker;
}
