/**
 * When invites go away (B029):
 *
 * - the `invite-expiry` job, every 5 minutes, marks lapsed pending invites expired and drops their
 *   key bundles, and drops the key bundles past their own time (accepted 15 minutes ago and never
 *   fetched). A key bundle therefore outlives its invite by 5 minutes at most. Idempotent: a run
 *   touches only what is due, so overlapping or repeated runs are harmless. A failed run is
 *   retried up to 3 attempts with exponential backoff and jitter (10 s base), then stays in the
 *   queue's failed set (the dead-letter set, kept 7 days), counted and logged;
 * - the `invites` hook of B027's workspace purge deletes a purged workspace's invites, before the
 *   workspace row goes (the foreign key restricts).
 *
 * Owns: the schedule, the processor, the queue and the purge hook. Must not: read or log a key
 * bundle (the store drops it unread), or log anything but counts.
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
import type { PurgeHookRegistry } from './workspace-purge.js';

/** The BullMQ queue of the job. */
export const INVITE_EXPIRY_QUEUE = 'invite-expiry';
/** How often the job runs. */
export const INVITE_EXPIRY_EVERY_MS = 5 * 60 * 1000;
/** The id of the repeating schedule (one per queue, whatever the number of workers). */
export const INVITE_EXPIRY_SCHEDULER_ID = 'invite-expiry-every-5-minutes';
/** Attempts per run, the first included, before it is dead-lettered. */
export const INVITE_EXPIRY_ATTEMPTS = 3;
/** The first retry waits between half and all of this; each later one twice as long. */
export const INVITE_EXPIRY_BACKOFF_BASE_MS = 10_000;
/** Dead-lettered runs are kept this long, in seconds (7 days), for an operator to look at. */
export const INVITE_EXPIRY_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** The options every run carries (the queue's defaults and the scheduler's template). */
export function inviteExpiryJobOptions(): {
  attempts: number;
  backoff: BackoffOptions;
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: INVITE_EXPIRY_ATTEMPTS,
    // BullMQ's exponential backoff with jitter 0.5: retry n waits between half and all of
    // `delay · 2^(n-1)`.
    backoff: { type: 'exponential', delay: INVITE_EXPIRY_BACKOFF_BASE_MS, jitter: 0.5 },
    removeOnComplete: true,
    removeOnFail: { age: INVITE_EXPIRY_FAILED_RETENTION_S },
  };
}

/** What the processor needs. */
export interface InviteExpiryDeps {
  /** @centcom/db `createInviteStore(db)`. */
  store: { sweep(now: Date): Promise<{ expired: number; bundlesDropped: number }> };
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `invite.expiry_swept` (counts only), `invite.expiry_retry` and `.expiry_failed`. */
  logger?: Logger;
  /** Receives `invites_expired_total`, `invite_key_bundles_dropped_total` and `invite_expiry_failed_total`. */
  metrics?: Metrics;
}

/** One run: expires what is due and drops bundles past their time; returns the counts. */
export async function processInviteExpiry(
  deps: InviteExpiryDeps,
): Promise<{ expired: number; bundlesDropped: number }> {
  const result = await deps.store.sweep(new Date((deps.clock ?? Date.now)()));
  const metrics = deps.metrics ?? noopMetrics;
  if (result.expired > 0) metrics.counter('invites_expired_total').inc(result.expired);
  if (result.bundlesDropped > 0) {
    metrics.counter('invite_key_bundles_dropped_total').inc(result.bundlesDropped);
  }
  deps.logger?.info(
    { expired: result.expired, bundles_dropped: result.bundlesDropped },
    'invite.expiry_swept',
  );
  return result;
}

/** After a failed run: logs a retry, or counts and logs the run once it is dead-lettered. */
export function onInviteExpiryFailed(
  job: Pick<Job, 'id' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<InviteExpiryDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  // The error's kind only: its text can name the database host.
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? INVITE_EXPIRY_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'invite.expiry_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('invite_expiry_failed_total').inc();
  deps.logger?.error(fields, 'invite.expiry_failed');
}

/** Where BullMQ keeps the queue: a Redis connection and a key prefix. */
export interface InviteExpiryQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `invite-expiry` queue. */
export function createInviteExpiryQueue(options: InviteExpiryQueueOptions): Queue {
  return new Queue(INVITE_EXPIRY_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: inviteExpiryJobOptions(),
  });
}

/** Makes the job run every 5 minutes (idempotent: one schedule per queue). */
export async function scheduleInviteExpiry(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    INVITE_EXPIRY_SCHEDULER_ID,
    { every: INVITE_EXPIRY_EVERY_MS },
    { name: 'sweep', opts: inviteExpiryJobOptions() },
  );
}

/** Options for `startInviteExpiryWorker`. */
export interface InviteExpiryWorkerOptions extends InviteExpiryQueueOptions, InviteExpiryDeps {}

/** Starts a worker on the `invite-expiry` queue (one run at a time). Close it with `worker.close()`. */
export function startInviteExpiryWorker(options: InviteExpiryWorkerOptions): Worker {
  const worker = new Worker(INVITE_EXPIRY_QUEUE, () => processInviteExpiry(options), {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => onInviteExpiryFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'invite.worker_error'));
  return worker;
}

/** The name of the workspace-purge hook that deletes a purged workspace's invites. */
export const INVITE_PURGE_HOOK = 'invites';

/** Registers, on B027's purge hook registry, the hook deleting a purged workspace's invites. */
export function registerInvitePurgeHook(
  hooks: PurgeHookRegistry,
  /** @centcom/db `createInviteStore(db)`. */
  store: { deleteForWorkspace(workspaceId: string): Promise<number> },
): void {
  hooks.register(INVITE_PURGE_HOOK, async (workspaceId) => {
    await store.deleteForWorkspace(workspaceId);
  });
}
