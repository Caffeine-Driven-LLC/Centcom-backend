/**
 * The `dunning` queue (B078): the jobs of the payment-failure lifecycle, run by the API's
 * `DunningService` (injected as `runner`).
 *
 * - **`expire {}`**, every 5 minutes: drops workspaces whose grace or canceled period ended to
 *   `none`, announces the drops, and queues the reminders that are due (`DunningService.expire`).
 * - **`remind {workspaceId, day, firstFailedAt}`**: the grace-day reminder (0, 3 or 6) of one
 *   failure; queued for its due time, job id per workspace, failure and day, so it is queued
 *   once (`DunningService.remind`).
 * - **`wind-down {workspaceId}`**: 10 minutes after a drop, ends the workspace's live hosted
 *   sessions if it is still `none`; job id per workspace and drop, so one per drop
 *   (`DunningService.windDown`).
 *
 * `remind` and `wind-down` jobs get 5 attempts with exponential backoff (from 10 s, jitter 0.5);
 * after the last failed attempt the job is copied to the dead-letter queue `dunning.dead`
 * (kept 14 days for operators) and `dunning_dead_letters_total{job}` counts it. Completed jobs
 * are kept a day, so a job id queued again within the day does nothing. `createDunningScheduler`
 * is the API's `DunningScheduler` over this queue.
 *
 * Owns: the queues, the schedule, the job data checks and the worker. Must not: decide dunning
 * (the API's service does), or log anything but ids, job names and error kinds.
 */
import { isId } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import {
  Queue,
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
} from 'bullmq';

/** The queue's name (card B078). */
export const DUNNING_QUEUE = 'dunning';
/** The dead-letter queue (the card's `dunning:dead`; BullMQ queue names cannot hold `:`). */
export const DUNNING_DLQ = 'dunning.dead';
export const DUNNING_EXPIRE_JOB = 'expire';
export const DUNNING_REMIND_JOB = 'remind';
export const DUNNING_WIND_DOWN_JOB = 'wind-down';
/** How often `expire` runs (card B078: every 5 minutes). */
export const DUNNING_EXPIRE_EVERY_MS = 5 * 60 * 1000;
/** The id of `expire`'s schedule. */
export const DUNNING_EXPIRE_SCHEDULER_ID = 'dunning-expire-every-5-minutes';
/** Attempts of a `remind` or `wind-down` job, the first included (card B078: 5). */
export const DUNNING_ATTEMPTS = 5;
/** The first retry waits about this long; each later one about twice as long. */
export const DUNNING_BACKOFF_MS = 10_000;
/** Completed jobs are kept this long, in seconds (a day): their ids stay taken. */
export const DUNNING_COMPLETED_RETENTION_S = 24 * 60 * 60;
/** Failed and dead-lettered jobs are kept this long, in seconds (14 days). */
export const DUNNING_FAILED_RETENTION_S = 14 * 24 * 60 * 60;

const DAYS: ReadonlySet<number> = new Set([0, 3, 6]);

/** The API's dunning service, as the jobs call it. */
export interface DunningRunner {
  expire(now: Date): Promise<unknown>;
  remind(workspaceId: string, day: 0 | 3 | 6, firstFailedAt: Date, now: Date): Promise<string>;
  windDown(workspaceId: string): Promise<number>;
}

/** What the processor needs. */
export interface DunningJobDeps {
  runner: DunningRunner;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  /** Receives `dunning_dead_letters_total{job}`. */
  metrics?: Metrics;
}

/** The options of a `remind` or `wind-down` job. */
export function dunningJobOptions(): JobsOptions {
  return {
    attempts: DUNNING_ATTEMPTS,
    backoff: { type: 'exponential', delay: DUNNING_BACKOFF_MS, jitter: 0.5 },
    removeOnComplete: { age: DUNNING_COMPLETED_RETENTION_S },
    removeOnFail: { age: DUNNING_FAILED_RETENTION_S },
  };
}

/** The job id of a reminder. */
export const remindJobId = (workspaceId: string, firstFailedAt: Date, day: number): string =>
  `remind-${workspaceId}-${firstFailedAt.getTime()}-${day}`;

/** The job id of a wind-down. */
export const windDownJobId = (workspaceId: string, noneAt: Date): string =>
  `wind-down-${workspaceId}-${noneAt.getTime()}`;

/** The job as the processor reads it. */
export type DunningJob = Pick<Job<unknown>, 'name' | 'data'>;

const workspaceOf = (data: Record<string, unknown>): string => {
  const ws = data['workspaceId'];
  if (!isId('wsp', ws)) throw new UnrecoverableError('dunning: workspaceId must be a wsp_ id');
  return ws;
};

/** Runs one job. */
export async function processDunningJob(job: DunningJob, deps: DunningJobDeps): Promise<unknown> {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const now = new Date((deps.clock ?? Date.now)());
  switch (job.name) {
    case DUNNING_EXPIRE_JOB:
      return deps.runner.expire(now);
    case DUNNING_REMIND_JOB: {
      const ws = workspaceOf(data);
      const day = data['day'];
      const failed = typeof data['firstFailedAt'] === 'string' ? data['firstFailedAt'] : '';
      const firstFailedAt = new Date(failed);
      if (typeof day !== 'number' || !DAYS.has(day) || Number.isNaN(firstFailedAt.getTime())) {
        throw new UnrecoverableError('dunning: a reminder needs day 0, 3 or 6 and firstFailedAt');
      }
      return deps.runner.remind(ws, day as 0 | 3 | 6, firstFailedAt, now);
    }
    case DUNNING_WIND_DOWN_JOB:
      return deps.runner.windDown(workspaceOf(data));
    default:
      throw new UnrecoverableError('dunning: unknown job');
  }
}

/** After a failed attempt: logs a retry, or dead-letters the job once it has no attempt left. */
export async function onDunningJobFailed(
  job: Pick<Job<unknown>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<DunningJobDeps, 'logger' | 'metrics'>,
  dlq: Pick<Queue, 'add'>,
): Promise<void> {
  if (job === undefined) return;
  const fields = { job: job.name, job_id: job.id ?? 'unknown', attempts: job.attemptsMade };
  const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!final) {
    deps.logger?.warn({ ...fields, error: err.name }, 'dunning.job_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('dunning_dead_letters_total', { job: job.name }).inc();
  // The error's kind only: its text can name a host.
  deps.logger?.error({ ...fields, error: err.name }, 'dunning.dead_letter');
  await dlq.add(job.name, job.data, {
    jobId: String(job.id ?? 'unknown'),
    removeOnComplete: true,
    removeOnFail: { age: DUNNING_FAILED_RETENTION_S },
  });
}

/** The API's `DunningScheduler`, over the `dunning` queue. */
export function createDunningScheduler(
  queue: Pick<Queue, 'add' | 'remove'>,
  clock: () => number = Date.now,
) {
  const delay = (at: Date): number => Math.max(0, at.getTime() - clock());
  return {
    async remind(job: { workspaceId: string; day: 0 | 3 | 6; firstFailedAt: Date; at: Date }) {
      await queue.add(
        DUNNING_REMIND_JOB,
        {
          workspaceId: job.workspaceId,
          day: job.day,
          firstFailedAt: job.firstFailedAt.toISOString(),
        },
        {
          ...dunningJobOptions(),
          jobId: remindJobId(job.workspaceId, job.firstFailedAt, job.day),
          delay: delay(job.at),
        },
      );
    },
    async cancelReminders(workspaceId: string, firstFailedAt: Date) {
      // A job a worker holds is not removed; its run finds the failure settled and does nothing.
      for (const day of DAYS) await queue.remove(remindJobId(workspaceId, firstFailedAt, day));
    },
    async windDown(job: { workspaceId: string; noneAt: Date; at: Date }) {
      await queue.add(
        DUNNING_WIND_DOWN_JOB,
        { workspaceId: job.workspaceId },
        {
          ...dunningJobOptions(),
          jobId: windDownJobId(job.workspaceId, job.noneAt),
          delay: delay(job.at),
        },
      );
    },
  };
}

/** Where BullMQ keeps the queues. */
export interface DunningQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

const queueOpts = (options: DunningQueueOptions) => ({
  connection: options.connection,
  ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
});

/** The `dunning` queue. */
export function createDunningQueue(options: DunningQueueOptions): Queue {
  return new Queue(DUNNING_QUEUE, {
    ...queueOpts(options),
    defaultJobOptions: dunningJobOptions(),
  });
}

/** The dead-letter queue `dunning.dead` (no worker: operators replay from it). */
export function createDunningDlq(options: DunningQueueOptions): Queue {
  return new Queue(DUNNING_DLQ, queueOpts(options));
}

/** Makes `expire` run every 5 minutes (idempotent: one schedule per queue). */
export async function scheduleDunningExpire(
  queue: Pick<Queue, 'upsertJobScheduler'>,
): Promise<void> {
  await queue.upsertJobScheduler(
    DUNNING_EXPIRE_SCHEDULER_ID,
    { every: DUNNING_EXPIRE_EVERY_MS },
    {
      name: DUNNING_EXPIRE_JOB,
      data: {},
      // A failed run is not retried: the next one, 5 minutes later, does the same work.
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
    },
  );
}

/** Options for `startDunningWorker`. */
export interface DunningWorkerOptions extends DunningQueueOptions, DunningJobDeps {
  /** The dead-letter queue. */
  dlq: Pick<Queue, 'add'>;
  /** Default 4. */
  concurrency?: number;
}

/** Starts a worker on `dunning`. Close it with `worker.close()`. */
export function startDunningWorker(options: DunningWorkerOptions): Worker {
  const worker = new Worker(DUNNING_QUEUE, (job: Job<unknown>) => processDunningJob(job, options), {
    ...queueOpts(options),
    concurrency: options.concurrency ?? 4,
  });
  worker.on('failed', (job, err) => {
    void onDunningJobFailed(job, err, options, options.dlq).catch(() =>
      options.logger?.error({ job_id: job?.id ?? 'unknown' }, 'dunning.dead_letter_failed'),
    );
  });
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'dunning.worker_error'));
  return worker;
}
