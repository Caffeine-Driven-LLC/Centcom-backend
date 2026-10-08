/**
 * The `usage.aggregate` job (B075): every 15 seconds, folds new usage into counters and checks
 * quota crossings (the API's `UsageAggregator.run`, injected as `run`). One schedule per queue
 * whatever the number of workers, one run at a time. A run is idempotent (the high-water mark moves
 * with the counters), so a failed run is simply retried, 3 attempts with backoff, then
 * dead-lettered (kept 7 days); the next run comes all the same and redoes the window.
 *
 * Owns: the schedule, the queue and the worker.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

/** The queue's name. */
export const USAGE_AGGREGATE_QUEUE = 'usage.aggregate';
/** How often it runs (the API's USAGE_AGGREGATE_EVERY_MS). */
export const USAGE_AGGREGATE_EVERY_MS = 15_000;
/** The id of the repeating schedule. */
export const USAGE_AGGREGATE_SCHEDULER_ID = 'usage-aggregate-every-15-seconds';
/** Attempts per run, the first included. */
export const USAGE_AGGREGATE_ATTEMPTS = 3;
/** Dead-lettered runs are kept this long, in seconds (7 days). */
export const USAGE_AGGREGATE_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** The options every run carries. */
export function usageAggregateJobOptions() {
  return {
    attempts: USAGE_AGGREGATE_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 2_000, jitter: 0.5 },
    removeOnComplete: true as const,
    removeOnFail: { age: USAGE_AGGREGATE_FAILED_RETENTION_S },
  };
}

/** What the processor needs. */
export interface UsageAggregateDeps {
  /** One run (`UsageAggregator.run`). */
  run(now: Date): Promise<{ workspaces: number; events: number }>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** One run, logged with its counts only. */
export async function processUsageAggregate(
  deps: UsageAggregateDeps,
): Promise<{ workspaces: number; events: number }> {
  const result = await deps.run(new Date((deps.clock ?? Date.now)()));
  if (result.events > 0 || result.workspaces > 0) {
    deps.logger?.debug(result, 'usage.aggregated');
  }
  return result;
}

/** Where BullMQ keeps the queue. */
export interface UsageAggregateQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `usage.aggregate` queue. */
export function createUsageAggregateQueue(options: UsageAggregateQueueOptions): Queue {
  return new Queue(USAGE_AGGREGATE_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: usageAggregateJobOptions(),
  });
}

/** Makes the job run every 15 seconds (idempotent: one schedule per queue). */
export async function scheduleUsageAggregate(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    USAGE_AGGREGATE_SCHEDULER_ID,
    { every: USAGE_AGGREGATE_EVERY_MS },
    { name: 'aggregate', opts: usageAggregateJobOptions() },
  );
}

/** Options for `startUsageAggregateWorker`. */
export interface UsageAggregateWorkerOptions
  extends UsageAggregateQueueOptions, UsageAggregateDeps {}

/** Starts a worker on the `usage.aggregate` queue (one run at a time). */
export function startUsageAggregateWorker(options: UsageAggregateWorkerOptions): Worker {
  const worker = new Worker(USAGE_AGGREGATE_QUEUE, () => processUsageAggregate(options), {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    (options.metrics ?? noopMetrics).counter('usage_aggregate_failed_total').inc();
    options.logger?.warn(
      { job_id: job?.id ?? 'unknown', attempts: job?.attemptsMade ?? 0, error: err.name },
      'usage.aggregate_failed',
    );
  });
  return worker;
}
