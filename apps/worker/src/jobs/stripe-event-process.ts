/**
 * The `stripe.event.process` queue (B072): processes stored Stripe webhook events.
 *
 * - `process` jobs (job id the `evt_` id, so an event is queued once): the API's
 *   `EventProcessor.process`, injected as `process`, told whether this is the last of the 8
 *   attempts (exponential backoff from 2 s with 50 % jitter). On the last failed attempt the
 *   processor marks the event `failed`, and the job is copied to the dead-letter queue
 *   `stripe.event.dlq` (kept for operators; `replayEvent` reprocesses it after a fix).
 * - `sweep`, every minute: queues events still `received` or `processing` after a minute (their
 *   job was lost or never queued), publishes the billing outbox, and warns
 *   (`stripe_events_stale_total`) when the oldest unfinished event is over 10 minutes old.
 *
 * Owns: the queues, the schedule and the worker. Must not: log a payload or a Stripe id other
 * than the event's.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B072). */
export const STRIPE_EVENT_QUEUE = 'stripe.event.process';
/** The dead-letter queue (card B072). */
export const STRIPE_EVENT_DLQ = 'stripe.event.dlq';
/** The job that processes one event. */
export const STRIPE_EVENT_JOB = 'process';
/** The job that requeues stuck events and publishes the outbox. */
export const STRIPE_EVENT_SWEEP_JOB = 'sweep';
/** Attempts per event, the first included (card B072: 8). */
export const STRIPE_EVENT_ATTEMPTS = 8;
/** The first retry waits about this long; each later one about twice as long. */
export const STRIPE_EVENT_BACKOFF_MS = 2_000;
/** The share of each wait that is random. */
export const STRIPE_EVENT_JITTER = 0.5;
/** Failed and dead-lettered jobs are kept this long, in seconds (14 days). */
export const STRIPE_EVENT_FAILED_RETENTION_S = 14 * 24 * 60 * 60;
/** How often the sweep runs. */
export const STRIPE_EVENT_SWEEP_EVERY_MS = 60_000;
/** The id of the sweep's schedule. */
export const STRIPE_EVENT_SWEEP_SCHEDULER_ID = 'stripe-event-sweep-every-minute';
/** An unfinished event older than this is requeued by the sweep. */
export const STRIPE_EVENT_REQUEUE_AFTER_MS = 60_000;
/** An unfinished event older than this is an alert (card B072: 10 minutes). */
export const STRIPE_EVENT_STALE_ALERT_MS = 10 * 60 * 1000;
/** Events one sweep requeues at most. */
export const STRIPE_EVENT_SWEEP_BATCH = 500;

const EVENT_ID = /^evt_[A-Za-z0-9]{1,250}$/;

/** A process job's data. */
export interface StripeEventJobData {
  eventId: string;
}

/** The options every process job carries. */
export function stripeEventJobOptions() {
  return {
    attempts: STRIPE_EVENT_ATTEMPTS,
    backoff: {
      type: 'exponential' as const,
      delay: STRIPE_EVENT_BACKOFF_MS,
      jitter: STRIPE_EVENT_JITTER,
    },
    removeOnComplete: true as const,
    removeOnFail: { age: STRIPE_EVENT_FAILED_RETENTION_S },
  };
}

/** Somewhere to add jobs. */
export type StripeEventQueueLike = Pick<Queue, 'add'>;

/** Queues event `eventId` (the API's `EventQueue.enqueue`). */
export async function enqueueStripeEvent(
  queue: StripeEventQueueLike,
  eventId: string,
): Promise<void> {
  await queue.add(STRIPE_EVENT_JOB, { eventId }, { ...stripeEventJobOptions(), jobId: eventId });
}

/** What the processor needs: the API's event processor and stores. */
export interface StripeEventDeps {
  /** `EventProcessor.process`. */
  process(eventId: string, opts: { finalAttempt: boolean }): Promise<string>;
  /** Unfinished events received before `before`, oldest first (`StripeEventStore.waiting`). */
  waiting(before: Date, limit: number): Promise<string[]>;
  /** When the oldest unfinished event was received (`StripeEventStore.oldestWaiting`). */
  oldestWaiting(): Promise<Date | null>;
  /** Publishes the billing outbox (`publishOutbox`). */
  publish(): Promise<unknown>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `stripe_event_dead_letters_total` and `stripe_events_stale_total`. */
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type StripeEventJob = Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'>;

/** Runs one job: an event, or a sweep. */
export async function processStripeEventJob(
  job: StripeEventJob,
  deps: StripeEventDeps,
  queue: StripeEventQueueLike,
): Promise<string> {
  if (job.name === STRIPE_EVENT_SWEEP_JOB) {
    const now = (deps.clock ?? Date.now)();
    const stuck = await deps.waiting(
      new Date(now - STRIPE_EVENT_REQUEUE_AFTER_MS),
      STRIPE_EVENT_SWEEP_BATCH,
    );
    for (const id of stuck) await enqueueStripeEvent(queue, id);
    await deps.publish();
    const oldest = await deps.oldestWaiting();
    if (oldest !== null && now - oldest.getTime() > STRIPE_EVENT_STALE_ALERT_MS) {
      (deps.metrics ?? noopMetrics).counter('stripe_events_stale_total').inc();
      deps.logger?.warn(
        { oldest_age_s: Math.round((now - oldest.getTime()) / 1000) },
        'stripe_event.backlog_stale',
      );
    }
    if (stuck.length > 0) deps.logger?.info({ requeued: stuck.length }, 'stripe_event.swept');
    return 'swept';
  }
  const eventId = (job.data as Partial<StripeEventJobData> | null)?.eventId;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    throw new UnrecoverableError('stripe.event.process: bad job data');
  }
  const attempts = job.opts.attempts ?? STRIPE_EVENT_ATTEMPTS;
  return deps.process(eventId, { finalAttempt: job.attemptsMade + 1 >= attempts });
}

/** After a failed attempt: logs a retry, or dead-letters the job once it has no attempt left. */
export async function onStripeEventFailed(
  job: Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<StripeEventDeps, 'logger' | 'metrics'>,
  dlq: Pick<Queue, 'add'>,
): Promise<void> {
  if (job === undefined || job.name !== STRIPE_EVENT_JOB) return;
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? STRIPE_EVENT_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'stripe_event.job_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('stripe_event_dead_letters_total').inc();
  deps.logger?.error(fields, 'stripe_event.dead_letter');
  await dlq.add('dead', job.data, {
    jobId: String(job.id ?? 'unknown'),
    removeOnComplete: true,
    removeOnFail: { age: STRIPE_EVENT_FAILED_RETENTION_S },
  });
}

/** Where BullMQ keeps the queues. */
export interface StripeEventQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

const queueOpts = (options: StripeEventQueueOptions) => ({
  connection: options.connection,
  ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
});

/** The `stripe.event.process` queue (the API's `EventQueue`). */
export function createStripeEventQueue(options: StripeEventQueueOptions): Queue {
  return new Queue(STRIPE_EVENT_QUEUE, {
    ...queueOpts(options),
    defaultJobOptions: stripeEventJobOptions(),
  });
}

/** The dead-letter queue `stripe.event.dlq` (no worker: operators replay from it). */
export function createStripeEventDlq(options: StripeEventQueueOptions): Queue {
  return new Queue(STRIPE_EVENT_DLQ, queueOpts(options));
}

/** Makes the sweep run every minute (idempotent: one schedule per queue). */
export async function scheduleStripeEventSweep(queue: Pick<Queue, 'upsertJobScheduler'>) {
  await queue.upsertJobScheduler(
    STRIPE_EVENT_SWEEP_SCHEDULER_ID,
    { every: STRIPE_EVENT_SWEEP_EVERY_MS },
    {
      name: STRIPE_EVENT_SWEEP_JOB,
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
    },
  );
}

/** Options for `startStripeEventWorker`. */
export interface StripeEventWorkerOptions extends StripeEventQueueOptions, StripeEventDeps {
  /** The worker's own queue (the sweep requeues into it). */
  queue: StripeEventQueueLike;
  /** The dead-letter queue. */
  dlq: Pick<Queue, 'add'>;
  /** Default 4. */
  concurrency?: number;
}

/** Starts a worker on `stripe.event.process`. Close it with `worker.close()`. */
export function startStripeEventWorker(options: StripeEventWorkerOptions): Worker {
  const worker = new Worker(
    STRIPE_EVENT_QUEUE,
    (job: Job<unknown>) => processStripeEventJob(job, options, options.queue),
    { ...queueOpts(options), concurrency: options.concurrency ?? 4 },
  );
  worker.on('failed', (job, err) => {
    void onStripeEventFailed(job, err, options, options.dlq).catch(() =>
      options.logger?.error({ job_id: job?.id ?? 'unknown' }, 'stripe_event.dead_letter_failed'),
    );
  });
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'stripe_event.worker_error'),
  );
  return worker;
}
