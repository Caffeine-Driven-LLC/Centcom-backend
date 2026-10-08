/**
 * The `telemetry-retention` queue (B085, CT-TELEMETRY rule 5): daily rollups and partition drops,
 * through the API's `TelemetryRetention` (injected as `rollup` and `drop`).
 *
 * - `rollup` jobs (`{day?: 'YYYY-MM-DD'}`): roll a day up once; without a day, every day before
 *   today that is not rolled up yet. Scheduled daily at 00:10 UTC.
 * - `drop` jobs (`{before?: 'YYYY-MM-DD'}`): drop the day partitions before a day, rolling up any
 *   not rolled up first; without a date, those older than 90 days. Scheduled daily at 00:20 UTC.
 *
 * Both are idempotent, so retries (3 attempts, backoff) and repeated runs are harmless, and a run
 * after missed ones catches up. Owns: the queue, the schedules and the worker.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B085). */
export const TELEMETRY_RETENTION_QUEUE = 'telemetry-retention';
export const TELEMETRY_ROLLUP_JOB = 'rollup';
export const TELEMETRY_DROP_JOB = 'drop';
/** The schedules: daily, rollup first. */
export const TELEMETRY_ROLLUP_SCHEDULER_ID = 'telemetry-rollup-daily';
export const TELEMETRY_DROP_SCHEDULER_ID = 'telemetry-drop-daily';
export const TELEMETRY_ROLLUP_PATTERN = '10 0 * * *';
export const TELEMETRY_DROP_PATTERN = '20 0 * * *';
/** Attempts per run, the first included. */
export const TELEMETRY_RETENTION_ATTEMPTS = 3;
/** Dead-lettered runs are kept this long, in seconds (7 days). */
export const TELEMETRY_RETENTION_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The options every run carries. */
export function telemetryRetentionJobOptions() {
  return {
    attempts: TELEMETRY_RETENTION_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 30_000 },
    removeOnComplete: true as const,
    removeOnFail: { age: TELEMETRY_RETENTION_FAILED_RETENTION_S },
  };
}

/** What the processor needs: the API's `TelemetryRetention`. */
export interface TelemetryRetentionDeps {
  rollup(day?: string): Promise<string[]>;
  drop(before?: string): Promise<string[]>;
  logger?: Logger;
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type TelemetryRetentionJob = Pick<Job<unknown>, 'name' | 'data'>;

/** Runs one job. */
export async function processTelemetryRetention(
  job: TelemetryRetentionJob,
  deps: TelemetryRetentionDeps,
): Promise<{ days: string[] }> {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const pick = (field: string): string | undefined => {
    const value = data[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !DAY.test(value)) {
      throw new UnrecoverableError(`telemetry-retention: ${field} must be YYYY-MM-DD`);
    }
    return value;
  };
  if (job.name === TELEMETRY_ROLLUP_JOB) return { days: await deps.rollup(pick('day')) };
  if (job.name === TELEMETRY_DROP_JOB) return { days: await deps.drop(pick('before')) };
  throw new UnrecoverableError('telemetry-retention: unknown job');
}

/** Where BullMQ keeps the queue. */
export interface TelemetryRetentionQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `telemetry-retention` queue. */
export function createTelemetryRetentionQueue(options: TelemetryRetentionQueueOptions): Queue {
  return new Queue(TELEMETRY_RETENTION_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: telemetryRetentionJobOptions(),
  });
}

/** Schedules the daily rollup and drop (idempotent: one schedule each per queue). */
export async function scheduleTelemetryRetention(queue: Pick<Queue, 'upsertJobScheduler'>) {
  await queue.upsertJobScheduler(
    TELEMETRY_ROLLUP_SCHEDULER_ID,
    { pattern: TELEMETRY_ROLLUP_PATTERN, tz: 'UTC' },
    { name: TELEMETRY_ROLLUP_JOB, data: {}, opts: telemetryRetentionJobOptions() },
  );
  await queue.upsertJobScheduler(
    TELEMETRY_DROP_SCHEDULER_ID,
    { pattern: TELEMETRY_DROP_PATTERN, tz: 'UTC' },
    { name: TELEMETRY_DROP_JOB, data: {}, opts: telemetryRetentionJobOptions() },
  );
}

/** Options for `startTelemetryRetentionWorker`. */
export interface TelemetryRetentionWorkerOptions
  extends TelemetryRetentionQueueOptions, TelemetryRetentionDeps {}

/** Starts a worker on the queue (one run at a time). */
export function startTelemetryRetentionWorker(options: TelemetryRetentionWorkerOptions): Worker {
  const worker = new Worker(
    TELEMETRY_RETENTION_QUEUE,
    (job: Job<unknown>) => processTelemetryRetention(job, options),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) => {
    (options.metrics ?? noopMetrics).counter('telemetry_retention_failed_total').inc();
    // The error's kind only: its text can name the database host.
    options.logger?.warn(
      { job: job?.name ?? 'unknown', attempts: job?.attemptsMade ?? 0, error: err.name },
      'telemetry.retention_failed',
    );
  });
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'telemetry.worker_error'));
  return worker;
}
