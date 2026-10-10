/**
 * The `quota-signals` queue (B076): jobs `evaluate {workspaceId}` and `sweep {}` calling the API's
 * `QuotaSignals.evaluateQuota` and `sweepQuota` (injected as `evaluate` and `sweep`).
 *
 * - **evaluate** is queued by usage-aggregate updates (`enqueueQuotaEvaluate`, from the API's
 *   `withQuotaSignals`), by entitlement changes and by the sweep. Its job id is the workspace's
 *   (`evaluate-<wsp>`) and it waits QUOTA_EVAL_DEBOUNCE_MS (10 s): while one is waiting or running,
 *   another for the same workspace is not queued, so a burst of updates makes one evaluation, and
 *   it reads the latest counters when it runs.
 * - **sweep** runs every QUOTA_SWEEP_INTERVAL_S (60 s; one schedule per queue) and queues an
 *   evaluation for each candidate (no wait): the backstop for a lost trigger, a delivery still to
 *   do, and a period that just ended.
 * - **Failures:** 5 attempts with exponential backoff from 2 s with jitter; then the job is copied
 *   to the dead-letter queue `quota-signals.dead` (kept 7 days; the card's `quota-signals:dead`,
 *   but BullMQ refuses `:` in a queue name) and removed, so the workspace's job id is free for the
 *   next trigger. The evaluation itself is idempotent (stored signals fire once), so a retry or a
 *   later sweep finishes what a failed run left.
 *
 * Owns: the queues, the schedule and the worker. Must not: evaluate anything itself.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B076). */
export const QUOTA_SIGNALS_QUEUE = 'quota-signals';
/** Where jobs that failed every attempt are kept (BullMQ refuses `quota-signals:dead`). */
export const QUOTA_SIGNALS_DEAD_QUEUE = 'quota-signals.dead';
/** Attempts per job, the first included. */
export const QUOTA_SIGNALS_ATTEMPTS = 5;
/** The first retry waits between half and all of this; each later one twice as long. */
export const QUOTA_SIGNALS_BACKOFF_MS = 2_000;
/** Dead letters are kept this long, in seconds (7 days). */
export const QUOTA_SIGNALS_DEAD_RETENTION_S = 7 * 24 * 60 * 60;
/** The id of the sweep's schedule. */
export const QUOTA_SWEEP_SCHEDULER_ID = 'quota-signals-sweep';
/** The default wait of an evaluation (the API's QUOTA_EVAL_DEBOUNCE_MS). */
export const QUOTA_EVAL_DEBOUNCE_MS = 10_000;
/** The default sweep interval (the API's QUOTA_SWEEP_INTERVAL_S). */
export const QUOTA_SWEEP_INTERVAL_S = 60;

const WORKSPACE_ID = /^wsp_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The options every job carries. */
export function quotaSignalsJobOptions() {
  return {
    attempts: QUOTA_SIGNALS_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: QUOTA_SIGNALS_BACKOFF_MS, jitter: 0.5 },
    removeOnComplete: true as const,
    // The dead-letter queue keeps the failed job; removing it frees the workspace's job id.
    removeOnFail: true as const,
  };
}

/** The job id of a workspace's evaluation (no `:`: real Redis refuses it in custom ids). */
export const evaluateJobId = (workspaceId: string): string => `evaluate-${workspaceId}`;

/** Queues the workspace's evaluation after `delayMs`, unless one is already waiting or running. */
export async function enqueueQuotaEvaluate(
  queue: Pick<Queue, 'add'>,
  workspaceId: string,
  delayMs: number = QUOTA_EVAL_DEBOUNCE_MS,
): Promise<void> {
  if (!WORKSPACE_ID.test(workspaceId)) throw new TypeError('workspaceId must be a wsp_ id');
  await queue.add(
    'evaluate',
    { workspaceId },
    { ...quotaSignalsJobOptions(), jobId: evaluateJobId(workspaceId), delay: delayMs },
  );
}

/** What the processor needs. */
export interface QuotaSignalsDeps {
  /** The API's `QuotaSignals.evaluateQuota(workspaceId)`. */
  evaluate(workspaceId: string): Promise<unknown>;
  /** The API's `sweepQuota`: queues every candidate; how many. */
  sweep(): Promise<number>;
  logger?: Logger;
  metrics?: Metrics;
}

/** One job (see the module comment); an unknown job or a bad workspace id is not retried. */
export async function processQuotaSignals(
  job: Pick<Job, 'name' | 'data'>,
  deps: QuotaSignalsDeps,
): Promise<unknown> {
  if (job.name === 'evaluate') {
    const workspaceId = (job.data as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) {
      throw new UnrecoverableError('evaluate needs a wsp_ workspaceId');
    }
    return deps.evaluate(workspaceId);
  }
  if (job.name === 'sweep') {
    const queued = await deps.sweep();
    if (queued > 0) deps.logger?.debug({ queued }, 'quota.swept');
    return { queued };
  }
  throw new UnrecoverableError('unknown quota-signals job');
}

/**
 * A failed attempt: logged as a retry while attempts remain; the last one (or an unrecoverable
 * error) is counted, logged by error kind only, and copied to the dead-letter queue.
 */
export async function onQuotaSignalsFailed(
  job: Pick<Job, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts' | 'timestamp'> | undefined,
  err: Error,
  deps: Pick<QuotaSignalsDeps, 'logger' | 'metrics'> & { deadLetter: Pick<Queue, 'add'> },
): Promise<void> {
  if (job === undefined) return;
  const fields = {
    job: job.name,
    job_id: job.id ?? 'unknown',
    attempts: job.attemptsMade,
    error: err.name,
  };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? QUOTA_SIGNALS_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'quota.job_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('quota_signal_jobs_failed_total', { job: job.name }).inc();
  deps.logger?.error(fields, 'quota.job_failed');
  try {
    await deps.deadLetter.add(
      'dead',
      { name: job.name, data: job.data as unknown, attempts: job.attemptsMade, error: err.name },
      {
        jobId: `dead-${String(job.id ?? 'unknown').replace(/:/g, '-')}-${job.timestamp}`,
        removeOnComplete: { age: QUOTA_SIGNALS_DEAD_RETENTION_S },
        removeOnFail: { age: QUOTA_SIGNALS_DEAD_RETENTION_S },
      },
    );
  } catch (dlqErr) {
    deps.logger?.error(
      { ...fields, dead_letter_error: dlqErr instanceof Error ? dlqErr.name : 'unknown' },
      'quota.dead_letter_failed',
    );
  }
}

/** Where BullMQ keeps the queues. */
export interface QuotaSignalsQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

const prefixOf = (o: QuotaSignalsQueueOptions) =>
  o.prefix === undefined ? {} : { prefix: o.prefix };

/** The `quota-signals` queue. */
export function createQuotaSignalsQueue(options: QuotaSignalsQueueOptions): Queue {
  return new Queue(QUOTA_SIGNALS_QUEUE, {
    connection: options.connection,
    ...prefixOf(options),
    defaultJobOptions: quotaSignalsJobOptions(),
  });
}

/** The dead-letter queue `quota-signals.dead`. */
export function createQuotaSignalsDeadQueue(options: QuotaSignalsQueueOptions): Queue {
  return new Queue(QUOTA_SIGNALS_DEAD_QUEUE, {
    connection: options.connection,
    ...prefixOf(options),
  });
}

/** Runs the sweep every `intervalS` seconds (idempotent: one schedule per queue). */
export async function scheduleQuotaSweep(
  queue: Pick<Queue, 'upsertJobScheduler'>,
  intervalS: number = QUOTA_SWEEP_INTERVAL_S,
): Promise<void> {
  await queue.upsertJobScheduler(
    QUOTA_SWEEP_SCHEDULER_ID,
    { every: intervalS * 1000 },
    { name: 'sweep', data: {}, opts: quotaSignalsJobOptions() },
  );
}

/** Options for `startQuotaSignalsWorker`. */
export interface QuotaSignalsWorkerOptions extends QuotaSignalsQueueOptions, QuotaSignalsDeps {
  deadLetter: Pick<Queue, 'add'>;
  /** Jobs at once (different workspaces; one workspace's evaluations never overlap); default 4. */
  concurrency?: number;
}

/** Starts a worker on the `quota-signals` queue. */
export function startQuotaSignalsWorker(options: QuotaSignalsWorkerOptions): Worker {
  const worker = new Worker(QUOTA_SIGNALS_QUEUE, (job) => processQuotaSignals(job, options), {
    connection: options.connection,
    ...prefixOf(options),
    concurrency: options.concurrency ?? 4,
  });
  worker.on('failed', (job, err) => void onQuotaSignalsFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'quota.worker_error'));
  return worker;
}

export {
  createQuotaStateRedisClient,
  createRedisQuotaStateCache,
  quotaStateRedisKey,
  type QuotaStateFields,
  type QuotaStateRedisClientOptions,
  type RedisQuotaStateCache,
} from './state-cache.js';
