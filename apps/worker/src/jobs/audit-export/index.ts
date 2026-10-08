/**
 * The `audit-export` queue (B082, CT-API-AUDIT): audit log exports, and the sweep that expires them.
 *
 * - `export` jobs (job id the `exp_` id, so one export is queued once): the API's
 *   `AuditExportRunner.run`, injected as `run`, with whether this is the last of the 3 attempts
 *   (fixed 10 s apart); the runner marks the export failed on the last one. Dead-lettered jobs are
 *   kept 7 days.
 * - `sweep`, every 5 minutes (one schedule per queue): `AuditExportRunner.sweep` deletes the files
 *   of expired exports and fails exports stuck for an hour, and the exports it finds still pending
 *   (their job was never queued) are queued again.
 *
 * Owns: the queue, the schedule and the worker. Must not: log an export's content or filters.
 */
import { isId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B082). */
export const AUDIT_EXPORT_QUEUE = 'audit-export';
/** The job that writes one export. */
export const AUDIT_EXPORT_JOB = 'export';
/** The job that expires files and requeues stuck exports. */
export const AUDIT_EXPORT_SWEEP_JOB = 'sweep';
/** Attempts per export, the first included. */
export const AUDIT_EXPORT_ATTEMPTS = 3;
/** The wait between attempts. */
export const AUDIT_EXPORT_BACKOFF_MS = 10_000;
/** Dead-lettered jobs are kept this long, in seconds (7 days). */
export const AUDIT_EXPORT_FAILED_RETENTION_S = 7 * 24 * 60 * 60;
/** How often the sweep runs. */
export const AUDIT_EXPORT_SWEEP_EVERY_MS = 5 * 60 * 1000;
/** The id of the sweep's schedule. */
export const AUDIT_EXPORT_SWEEP_SCHEDULER_ID = 'audit-export-sweep-every-5-minutes';
/** Exports one worker writes at once. */
export const AUDIT_EXPORT_CONCURRENCY = 2;

/** An export job's data. */
export interface AuditExportJobData {
  exportId: string;
}

/** The options every export job carries. */
export function auditExportJobOptions() {
  return {
    attempts: AUDIT_EXPORT_ATTEMPTS,
    backoff: { type: 'fixed' as const, delay: AUDIT_EXPORT_BACKOFF_MS },
    removeOnComplete: true as const,
    removeOnFail: { age: AUDIT_EXPORT_FAILED_RETENTION_S },
  };
}

/** The options of a sweep run: one attempt, the next run retries. */
export function auditExportSweepOptions() {
  return {
    attempts: 1,
    removeOnComplete: true as const,
    removeOnFail: { age: AUDIT_EXPORT_FAILED_RETENTION_S },
  };
}

/** Somewhere to add jobs. */
export type AuditExportQueueLike = Pick<Queue, 'add'>;

/** Queues export `exportId` (the API's `AuditExportQueue.enqueue`). */
export async function enqueueAuditExport(
  queue: AuditExportQueueLike,
  exportId: string,
): Promise<void> {
  await queue.add(AUDIT_EXPORT_JOB, { exportId }, { ...auditExportJobOptions(), jobId: exportId });
}

/** What the processor needs: the API's export runner. */
export interface AuditExportDeps {
  /** `AuditExportRunner.run`. */
  run(
    exportId: string,
    opts: { finalAttempt: boolean },
  ): Promise<'ready' | 'row_cap_exceeded' | 'skipped'>;
  /** `AuditExportRunner.sweep`. */
  sweep(now: Date): Promise<{ expired: number; failed: number; stale: string[] }>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type AuditExportJob = Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'>;

/** Runs one job: an export, or a sweep that queues the exports it finds stuck. */
export async function processAuditExport(
  job: AuditExportJob,
  deps: AuditExportDeps,
  queue: AuditExportQueueLike,
): Promise<string> {
  if (job.name === AUDIT_EXPORT_SWEEP_JOB) {
    const { expired, failed, stale } = await deps.sweep(new Date((deps.clock ?? Date.now)()));
    for (const id of stale) await enqueueAuditExport(queue, id);
    if (expired > 0 || failed > 0 || stale.length > 0) {
      deps.logger?.info({ expired, failed, requeued: stale.length }, 'audit_export.swept');
    }
    return 'swept';
  }
  const exportId = (job.data as Partial<AuditExportJobData> | null)?.exportId;
  if (!isId('exp', exportId)) throw new UnrecoverableError('audit-export: bad job data');
  const attempts = job.opts.attempts ?? AUDIT_EXPORT_ATTEMPTS;
  return deps.run(exportId, { finalAttempt: job.attemptsMade + 1 >= attempts });
}

/** Where BullMQ keeps the queue. */
export interface AuditExportQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `audit-export` queue. */
export function createAuditExportQueue(options: AuditExportQueueOptions): Queue {
  return new Queue(AUDIT_EXPORT_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: auditExportJobOptions(),
  });
}

/** Makes the sweep run every 5 minutes (idempotent: one schedule per queue). */
export async function scheduleAuditExportSweep(queue: Pick<Queue, 'upsertJobScheduler'>) {
  await queue.upsertJobScheduler(
    AUDIT_EXPORT_SWEEP_SCHEDULER_ID,
    { every: AUDIT_EXPORT_SWEEP_EVERY_MS },
    { name: AUDIT_EXPORT_SWEEP_JOB, opts: auditExportSweepOptions() },
  );
}

/** After a failed attempt: counts and logs the job once it is dead-lettered. */
export function onAuditExportFailed(
  job: Pick<Job<unknown>, 'id' | 'name' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<AuditExportDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  // The error's kind only: its text can name a host.
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? AUDIT_EXPORT_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'audit_export.retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('audit_export_dead_letters_total', { job: job.name }).inc();
  deps.logger?.warn(fields, 'audit_export.dead_letter');
}

/** Options for `startAuditExportWorker`. */
export interface AuditExportWorkerOptions extends AuditExportQueueOptions, AuditExportDeps {
  /** Where the sweep queues stuck exports; the worker's own queue. */
  queue: AuditExportQueueLike;
  /** Default AUDIT_EXPORT_CONCURRENCY. */
  concurrency?: number;
}

/** Starts a worker on the `audit-export` queue. */
export function startAuditExportWorker(options: AuditExportWorkerOptions): Worker {
  const worker = new Worker(
    AUDIT_EXPORT_QUEUE,
    (job: Job<unknown>) => processAuditExport(job, options, options.queue),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: options.concurrency ?? AUDIT_EXPORT_CONCURRENCY,
    },
  );
  worker.on('failed', (job, err) => onAuditExportFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'audit_export.worker_error'),
  );
  return worker;
}
