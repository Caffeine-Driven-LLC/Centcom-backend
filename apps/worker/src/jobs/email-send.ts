/**
 * The `email-send` job (B032): delivers the emails `EmailService.send` queued, through the
 * configured provider.
 *
 * - Each provider call is cut off after EMAIL_TIMEOUT_MS (10 s by default).
 * - Failures are retried by BullMQ up to 5 attempts, waiting exponentially longer (30 s base, with
 *   jitter), or as long as the provider's Retry-After asks.
 * - The 5th failure leaves the job in the queue's failed set, which is the dead-letter set, and
 *   counts `email_failed_total`. Permanent rejections (4xx but 429) fail at once, counted in
 *   `email_rejected_total` as well.
 * - A delivered job is remembered for 24 h, so a job BullMQ hands out again never sends twice.
 *
 * Owns: the queue options, the worker and the job processor. Must not: retry a permanent
 * rejection, or log a recipient, a parameter, a link or a body.
 */
import {
  EMAIL_JOB_ATTEMPTS,
  EMAIL_QUEUE,
  emailJobOptions,
  EmailProviderError,
  noopMetrics,
  type EmailJobData,
  type EmailProvider,
  type KeyValue,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The first retry waits about this long; each later one about twice as long. */
export const EMAIL_BACKOFF_BASE_MS = 30_000;
/** No retry waits longer. */
export const EMAIL_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** How long a delivered job is remembered. */
export const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
/** The provider timeout when none is configured (EMAIL_TIMEOUT_MS). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Where BullMQ keeps the queue: a Redis connection and a key prefix (`ct:<env>:bull`). */
export interface EmailQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `email-send` queue, for producers (EmailService's queue). */
export function createEmailQueue(options: EmailQueueOptions): Queue<EmailJobData> {
  return new Queue<EmailJobData>(EMAIL_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    // EmailService passes the same options with every job; these cover anything else added here.
    defaultJobOptions: emailJobOptions(),
  });
}

/**
 * The wait before retrying after `attemptsMade` failures: the provider's Retry-After when it gave
 * one, else between half and all of `base · 2^(attemptsMade - 1)`, at most EMAIL_BACKOFF_MAX_MS.
 */
export function emailBackoff(
  baseMs: number = EMAIL_BACKOFF_BASE_MS,
  random: () => number = Math.random,
): (attemptsMade: number, err?: Error) => number {
  return (attemptsMade, err) => {
    if (err instanceof EmailProviderError && err.retryAfterMs !== undefined) {
      return Math.min(err.retryAfterMs, EMAIL_BACKOFF_MAX_MS);
    }
    const ceiling = Math.min(EMAIL_BACKOFF_MAX_MS, baseMs * 2 ** Math.max(0, attemptsMade - 1));
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  };
}

/** What the processor needs. */
export interface EmailJobDeps {
  provider: EmailProvider;
  /** Remembers delivered jobs (B009 `RedisBackend.kv`). */
  kv: KeyValue;
  /** EMAIL_TIMEOUT_MS; default 10 s. */
  timeoutMs?: number;
  /** Writes `email.sent`, `email.rejected`, `email.retry` and `email.failed` (template and job id only). */
  logger?: Logger;
  /**
   * Receives `email_sent_total`, `email_rejected_total`, `email_failed_total` and
   * `email_unrecorded_total`, each by `template`.
   */
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type EmailJob = Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade'>;

/**
 * Delivers one queued email. Throws an UnrecoverableError (no retry) for a permanent rejection, and
 * rethrows anything else for BullMQ to retry.
 */
export async function processEmailJob(
  job: EmailJob,
  deps: EmailJobDeps,
): Promise<{ providerMessageId: string }> {
  const { provider, kv, logger } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  const template = job.data.template;
  const jobId = job.id ?? 'unknown';
  const delivered = `email:delivered:${jobId}`;
  const earlier = await kv.get(delivered);
  if (earlier !== null) return { providerMessageId: earlier };
  let result: { providerMessageId: string };
  try {
    result = await provider.send(
      job.data.email,
      AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof EmailProviderError && !err.retryable) {
      metrics.counter('email_rejected_total', { template }).inc();
      logger?.warn({ template, job_id: jobId, status: err.status }, 'email.rejected');
      throw new UnrecoverableError(`email rejected by ${provider.name}`);
    }
    throw err;
  }
  const { providerMessageId } = result;
  // Sent: failing to remember it only risks a resend if BullMQ hands the job out again.
  await kv.set(delivered, providerMessageId, { ttlMs: DELIVERED_TTL_MS }).catch(() => {
    metrics.counter('email_unrecorded_total', { template }).inc();
  });
  metrics.counter('email_sent_total', { template }).inc();
  logger?.info({ template, job_id: jobId, provider_message_id: providerMessageId }, 'email.sent');
  return result;
}

/** After a failed attempt: counts and logs the job once it is dead-lettered. */
export function onEmailJobFailed(
  job: Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<EmailJobDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  const template = job.data.template;
  const fields = { template, job_id: job.id ?? 'unknown', attempts: job.attemptsMade };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? EMAIL_JOB_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'email.retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('email_failed_total', { template }).inc();
  deps.logger?.error(fields, 'email.failed');
}

/** Options for `startEmailWorker`. */
export interface EmailWorkerOptions extends EmailQueueOptions, EmailJobDeps {
  /** Jobs processed at once; default 5. */
  concurrency?: number;
  /** The first retry's wait; default 30 s (tests shorten it). */
  backoffBaseMs?: number;
  /** Jitter source; default Math.random. */
  random?: () => number;
}

/** Starts a worker on the `email-send` queue. Close it with `worker.close()`. */
export function startEmailWorker(options: EmailWorkerOptions): Worker<EmailJobData> {
  const backoff = emailBackoff(options.backoffBaseMs, options.random);
  const worker = new Worker<EmailJobData>(EMAIL_QUEUE, (job) => processEmailJob(job, options), {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: options.concurrency ?? 5,
    settings: { backoffStrategy: (attemptsMade, _type, err) => backoff(attemptsMade, err) },
  });
  worker.on('failed', (job, err) => onEmailJobFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'email.worker_error'));
  return worker;
}
