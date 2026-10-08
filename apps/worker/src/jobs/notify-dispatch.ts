/**
 * The `notify.dispatch` job (B063): dispatches one published notification event (the API's
 * `NotificationDispatcher.process`, injected as `process`). A failed run is retried up to 5
 * attempts with exponential backoff and jitter (5 s base); after the last one the job's event is
 * copied to the `notify.dispatch.dlq` queue (the dead-letter queue, for an operator to replay),
 * counted and logged. Dispatching is idempotent (one notification per user and event), so a retry
 * after a partial run only finishes it.
 *
 * Owns: the queue, the worker and the dead-lettering. Must not: log the event's params.
 */
import {
  noopMetrics,
  NOTIFY_DISPATCH_ATTEMPTS,
  NOTIFY_DISPATCH_DLQ,
  NOTIFY_DISPATCH_QUEUE,
  NOTIFY_FAILED_RETENTION_S,
  notifyDispatchJobOptions,
  type Logger,
  type Metrics,
  type NotifyDispatchJobData,
} from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** What a dead letter holds: the event, and how its last attempt ended. */
export interface NotifyDeadLetter {
  data: NotifyDispatchJobData;
  attempts: number;
  /** The error's kind only. */
  error: string;
  /** RFC 3339. */
  failedAt: string;
}

/** What the worker needs. */
export interface NotifyDispatchDeps {
  /** Dispatches one event (`NotificationDispatcher.process` in @centcom/api). */
  process(data: NotifyDispatchJobData): Promise<unknown>;
  /** The `notify.dispatch.dlq` queue (`createNotifyDeadLetterQueue`). */
  deadLetter: Pick<Queue, 'add'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `notification.dispatch_retry` and `.dispatch_failed` (job id, attempts, error kind). */
  logger?: Logger;
  /** Receives `notification_dispatch_failed_total`. */
  metrics?: Metrics;
}

/** Runs one job. */
export function processNotifyDispatch(
  job: Pick<Job<NotifyDispatchJobData>, 'data'>,
  deps: Pick<NotifyDispatchDeps, 'process'>,
): Promise<unknown> {
  return deps.process(job.data);
}

/** After a failed run: logs a retry, or dead-letters the event after the last attempt. */
export async function onNotifyDispatchFailed(
  job: Pick<Job<NotifyDispatchJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Omit<NotifyDispatchDeps, 'process'>,
): Promise<void> {
  if (job === undefined) return;
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? NOTIFY_DISPATCH_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'notification.dispatch_retry');
    return;
  }
  const letter: NotifyDeadLetter = {
    data: job.data,
    attempts: job.attemptsMade,
    error: err.name,
    failedAt: new Date((deps.clock ?? Date.now)()).toISOString(),
  };
  (deps.metrics ?? noopMetrics).counter('notification_dispatch_failed_total').inc();
  deps.logger?.error(fields, 'notification.dispatch_failed');
  try {
    await deps.deadLetter.add('dead', letter, {
      jobId: `dead-${job.data.eventId}`,
      removeOnComplete: { age: NOTIFY_FAILED_RETENTION_S },
      removeOnFail: { age: NOTIFY_FAILED_RETENTION_S },
    });
  } catch (dlqErr) {
    // The job also stays in the failed set (kept 7 days): nothing is lost.
    deps.logger?.error(
      { ...fields, dlq_error: dlqErr instanceof Error ? dlqErr.name : typeof dlqErr },
      'notification.dead_letter_failed',
    );
  }
}

/** Where BullMQ keeps the queues: a Redis connection and a key prefix. */
export interface NotifyQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

const prefixOf = (options: NotifyQueueOptions): { prefix?: string } =>
  options.prefix === undefined ? {} : { prefix: options.prefix };

/** The `notify.dispatch` queue (the API's `DispatchQueue`). */
export function createNotifyDispatchQueue(options: NotifyQueueOptions): Queue {
  return new Queue(NOTIFY_DISPATCH_QUEUE, {
    connection: options.connection,
    ...prefixOf(options),
    defaultJobOptions: notifyDispatchJobOptions(),
  });
}

/** The `notify.dispatch.dlq` queue. Nothing consumes it: an operator replays from it. */
export function createNotifyDeadLetterQueue(options: NotifyQueueOptions): Queue {
  return new Queue(NOTIFY_DISPATCH_DLQ, { connection: options.connection, ...prefixOf(options) });
}

/** Options for `startNotifyDispatchWorker`. */
export interface NotifyDispatchWorkerOptions extends NotifyQueueOptions, NotifyDispatchDeps {
  /** Jobs run at once; default 4. */
  concurrency?: number;
}

/** Starts a worker on `notify.dispatch`. Close it with `worker.close()`. */
export function startNotifyDispatchWorker(options: NotifyDispatchWorkerOptions): Worker {
  const worker = new Worker<NotifyDispatchJobData>(
    NOTIFY_DISPATCH_QUEUE,
    (job) => processNotifyDispatch(job, options),
    { connection: options.connection, ...prefixOf(options), concurrency: options.concurrency ?? 4 },
  );
  worker.on('failed', (job, err) => void onNotifyDispatchFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'notification.worker_error'),
  );
  return worker;
}
