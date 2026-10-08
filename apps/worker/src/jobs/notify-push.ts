/**
 * The `notify.push` job (B064): sends one notification to one user's push subscriptions (the
 * API's `PushDelivery.process`, injected as `process`). Retries happen inside the delivery, per
 * provider call; a job is one attempt. Deliveries a provider's open circuit deferred are queued
 * again as a new job for those subscriptions only, delayed until the circuit closes, so nothing
 * is dropped. A subscription deleted since the job was queued is simply not found (a no-op).
 *
 * Owns: the queue, the worker and the re-queueing. Must not: log the payload or any endpoint.
 */
import {
  NOTIFY_PUSH_QUEUE,
  noopMetrics,
  notifyPushJobOptions,
  type Logger,
  type Metrics,
  type NotifyPushJobData,
} from '@centcom/core';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** Jobs a worker runs at once. */
export const NOTIFY_PUSH_CONCURRENCY = 10;

/** What a delivery reports back (`DeliveryReport` in @centcom/api). */
export interface PushJobReport {
  deferred?: { subscriptionIds: string[]; delayMs: number };
}

/** What the worker needs. */
export interface NotifyPushDeps {
  /** Delivers one job's notification (`PushDelivery.process`). */
  process(data: NotifyPushJobData): Promise<PushJobReport>;
  /** The `notify.push` queue, for deferred deliveries. */
  queue: Pick<Queue, 'add'>;
  logger?: Logger;
  metrics?: Metrics;
}

/** Runs one job; re-queues what was deferred. */
export async function processNotifyPush(
  job: Pick<Job<NotifyPushJobData>, 'id' | 'data'>,
  deps: Omit<NotifyPushDeps, 'logger'> & { logger?: Logger },
): Promise<PushJobReport> {
  const report = await deps.process(job.data);
  if (report.deferred !== undefined && report.deferred.subscriptionIds.length > 0) {
    const { subscriptionIds, delayMs } = report.deferred;
    await deps.queue.add(
      NOTIFY_PUSH_QUEUE,
      { ...job.data, subscriptionIds },
      {
        ...notifyPushJobOptions(),
        delay: delayMs,
        jobId: `${job.id ?? 'push'}-deferred-${Date.now()}`,
      },
    );
    (deps.metrics ?? noopMetrics)
      .counter('push_deliveries_deferred_total')
      .inc(subscriptionIds.length);
    deps.logger?.info(
      { job_id: job.id, deferred: subscriptionIds.length, delay_ms: delayMs },
      'push.deferred',
    );
  }
  return report;
}

/** The `notify.push` queue. */
export function createNotifyPushQueue(connection: ConnectionOptions): Queue<NotifyPushJobData> {
  return new Queue<NotifyPushJobData>(NOTIFY_PUSH_QUEUE, { connection });
}

/** Starts the `notify.push` worker (10 jobs at once). */
export function startNotifyPushWorker(
  connection: ConnectionOptions,
  deps: NotifyPushDeps,
  concurrency = NOTIFY_PUSH_CONCURRENCY,
): Worker<NotifyPushJobData> {
  const worker = new Worker<NotifyPushJobData>(
    NOTIFY_PUSH_QUEUE,
    (job) => processNotifyPush(job, deps),
    { connection, concurrency },
  );
  worker.on('failed', (job, err) => {
    (deps.metrics ?? noopMetrics).counter('push_jobs_failed_total').inc();
    deps.logger?.error({ job_id: job?.id, error: err.name }, 'push.job_failed');
  });
  return worker;
}
