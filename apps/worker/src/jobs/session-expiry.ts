/**
 * The session expiry sweep (B053): the `session-expiry` job runs `session.expiry.sweep` every 60 s.
 * Each run asks the API's session lifecycle (`SessionService.sweep`, passed in as `sessions`) to
 * pause live sessions whose host has been gone 10 minutes, expire sessions paused 24 hours, and
 * retry notifications that did not go out.
 *
 * Idempotent and safe on several workers: the sweep holds a Postgres advisory lock, and each
 * transition is a conditional UPDATE, so an overlapping or repeated run changes nothing twice. A
 * crashed run leaves the rest for the next. A failed run is retried up to 3 attempts with
 * exponential backoff and jitter (5 s base), then stays in the queue's failed set (the
 * dead-letter set, kept 7 days), counted and logged.
 *
 * Owns: the schedule, the processor and the queue. Must not: log anything but counts.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  Queue,
  UnrecoverableError,
  Worker,
  type BackoffOptions,
  type ConnectionOptions,
  type Job,
} from 'bullmq';

/** The BullMQ queue of the job. */
export const SESSION_EXPIRY_QUEUE = 'session-expiry';
/** The job's name (B053's interface). */
export const SESSION_EXPIRY_JOB = 'session.expiry.sweep';
/** How often the job runs. */
export const SESSION_EXPIRY_EVERY_MS = 60 * 1000;
/** The id of the repeating schedule (one per queue, whatever the number of workers). */
export const SESSION_EXPIRY_SCHEDULER_ID = 'session-expiry-every-minute';
/** Attempts per run, the first included, before it is dead-lettered. */
export const SESSION_EXPIRY_ATTEMPTS = 3;
/** The first retry waits between half and all of this; each later one twice as long. */
export const SESSION_EXPIRY_BACKOFF_BASE_MS = 5_000;
/** Dead-lettered runs are kept this long, in seconds (7 days). */
export const SESSION_EXPIRY_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** The options every run carries (the queue's defaults and the scheduler's template). */
export function sessionExpiryJobOptions(): {
  attempts: number;
  backoff: BackoffOptions;
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: SESSION_EXPIRY_ATTEMPTS,
    backoff: { type: 'exponential', delay: SESSION_EXPIRY_BACKOFF_BASE_MS, jitter: 0.5 },
    removeOnComplete: true,
    removeOnFail: { age: SESSION_EXPIRY_FAILED_RETENTION_S },
  };
}

/** What the processor needs. */
export interface SessionExpiryDeps {
  /** The API's `SessionService` (B053). */
  sessions: { sweep(now: Date): Promise<{ paused: number; expired: number }> };
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `session.expiry_swept` (counts only), `session.expiry_retry` and `.expiry_failed`. */
  logger?: Logger;
  /** Receives `session_expiry_failed_total`. */
  metrics?: Metrics;
}

/** One run: pauses and expires what is due; returns the counts. */
export async function processSessionExpiry(
  deps: SessionExpiryDeps,
): Promise<{ paused: number; expired: number }> {
  const result = await deps.sessions.sweep(new Date((deps.clock ?? Date.now)()));
  deps.logger?.info({ paused: result.paused, expired: result.expired }, 'session.expiry_swept');
  return result;
}

/** After a failed run: logs a retry, or counts and logs the run once it is dead-lettered. */
export function onSessionExpiryFailed(
  job: Pick<Job, 'id' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<SessionExpiryDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  // The error's kind only: its text can name the database host.
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? SESSION_EXPIRY_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'session.expiry_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('session_expiry_failed_total').inc();
  deps.logger?.error(fields, 'session.expiry_failed');
}

/** Where BullMQ keeps the queue: a Redis connection and a key prefix. */
export interface SessionExpiryQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `session-expiry` queue. */
export function createSessionExpiryQueue(options: SessionExpiryQueueOptions): Queue {
  return new Queue(SESSION_EXPIRY_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: sessionExpiryJobOptions(),
  });
}

/** Makes `session.expiry.sweep` run every 60 s (idempotent: one schedule per queue). */
export async function scheduleSessionExpiry(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SESSION_EXPIRY_SCHEDULER_ID,
    { every: SESSION_EXPIRY_EVERY_MS },
    { name: SESSION_EXPIRY_JOB, opts: sessionExpiryJobOptions() },
  );
}

/** Options for `startSessionExpiryWorker`. */
export interface SessionExpiryWorkerOptions extends SessionExpiryQueueOptions, SessionExpiryDeps {}

/** Starts a worker on the `session-expiry` queue (one run at a time). Close it with `worker.close()`. */
export function startSessionExpiryWorker(options: SessionExpiryWorkerOptions): Worker {
  const worker = new Worker(SESSION_EXPIRY_QUEUE, () => processSessionExpiry(options), {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => onSessionExpiryFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'session.worker_error'));
  return worker;
}
