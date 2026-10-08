/**
 * The `notify.digest` job (B063): every hour, sends each user's waiting low/normal e-mail items as
 * one digest (the API's `runDigest`, injected as `run`). One schedule per queue whatever the
 * number of workers, one run at a time. A run is idempotent (items are marked sent with the send),
 * so a failed run is simply retried, 3 attempts with backoff, then dead-lettered in the failed set
 * (kept 7 days); the next hourly run comes all the same.
 *
 * Owns: the schedule, the queue and the worker.
 */
import {
  noopMetrics,
  NOTIFY_DIGEST_EVERY_MS,
  NOTIFY_DIGEST_QUEUE,
  NOTIFY_FAILED_RETENTION_S,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { Queue, Worker, type BackoffOptions } from 'bullmq';
import type { NotifyQueueOptions } from './notify-dispatch.js';

/** The id of the hourly schedule. */
export const NOTIFY_DIGEST_SCHEDULER_ID = 'notify-digest-hourly';
/** Attempts per run, the first included. */
export const NOTIFY_DIGEST_ATTEMPTS = 3;

/** The options every run carries. */
export function notifyDigestJobOptions(): {
  attempts: number;
  backoff: BackoffOptions;
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: NOTIFY_DIGEST_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 },
    removeOnComplete: true,
    removeOnFail: { age: NOTIFY_FAILED_RETENTION_S },
  };
}

/** What the worker needs. */
export interface NotifyDigestDeps {
  /** One digest run (`runDigest` in @centcom/api). */
  run(): Promise<{ emails: number; items: number }>;
  logger?: Logger;
  /** Receives `notification_digest_runs_failed_total`. */
  metrics?: Metrics;
}

/** The `notify.digest` queue. */
export function createNotifyDigestQueue(options: NotifyQueueOptions): Queue {
  return new Queue(NOTIFY_DIGEST_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: notifyDigestJobOptions(),
  });
}

/** Makes the digest run every hour (idempotent: one schedule per queue). */
export async function scheduleNotifyDigest(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    NOTIFY_DIGEST_SCHEDULER_ID,
    { every: NOTIFY_DIGEST_EVERY_MS },
    { name: 'digest', opts: notifyDigestJobOptions() },
  );
}

/** Starts a worker on `notify.digest` (one run at a time). */
export function startNotifyDigestWorker(options: NotifyQueueOptions & NotifyDigestDeps): Worker {
  const worker = new Worker(NOTIFY_DIGEST_QUEUE, () => options.run(), {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    const final =
      job !== undefined && job.attemptsMade >= (job.opts.attempts ?? NOTIFY_DIGEST_ATTEMPTS);
    if (final)
      (options.metrics ?? noopMetrics).counter('notification_digest_runs_failed_total').inc();
    options.logger?.[final ? 'error' : 'info'](
      { job_id: job?.id ?? 'unknown', attempts: job?.attemptsMade ?? 0, error: err.name },
      final ? 'notification.digest_run_failed' : 'notification.digest_run_retry',
    );
  });
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'notification.worker_error'),
  );
  return worker;
}
