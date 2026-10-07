/**
 * The `workspace-purge` job (B027): after the API deletes a workspace (hiding it at once), this
 * job removes it for good:
 *
 * 1. announces `workspace.deleted` on Redis again (the API's announcement may have failed);
 * 2. runs the purge hooks other lanes register (session history, snapshots, billing wind-down),
 *    in registration order;
 * 3. hard-deletes the workspace and the rows that reference it (@centcom/db `purge`).
 *
 * The job is idempotent: hooks must be, and purging a workspace that is already gone does
 * nothing, so a job run twice, or retried after a partial failure, is safe. A failure is retried
 * up to 5 attempts with exponential backoff and jitter (10 s base), then the job stays in the
 * queue's failed set (the dead-letter set, kept 7 days), counted and logged.
 *
 * Owns: the hook registry, the processor, the backoff and the queue. Must not: purge a workspace
 * that is not deleted (the store refuses), or log anything but ids, hook names and error kinds.
 */
import { isId } from '@centcom/contracts';
import {
  noopMetrics,
  publishWorkspaceDeleted,
  WORKSPACE_PURGE_ATTEMPTS,
  WORKSPACE_PURGE_QUEUE,
  workspacePurgeJobOptions,
  type Logger,
  type Metrics,
  type PubSub,
  type WorkspacePurgeJobData,
} from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The first retry waits about this long; each later one about twice as long. */
export const WORKSPACE_PURGE_BACKOFF_BASE_MS = 10_000;
/** No retry waits longer. */
export const WORKSPACE_PURGE_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** What a hook is told. */
export interface PurgeCtx {
  /** When this run started, in milliseconds. */
  now: number;
  /** This run's attempt, from 1. */
  attempt: number;
}

/** Removes one kind of a deleted workspace's data; must be idempotent (it may run again). */
export type PurgeHook = (workspaceId: string, ctx: PurgeCtx) => Promise<void>;

/** The purge hooks, by name. */
export interface PurgeHookRegistry {
  /** Adds a hook that runs after those registered before it; a TypeError for a name used twice. */
  register(name: string, hook: PurgeHook): void;
  /** The hooks, in registration order. */
  list(): readonly { name: string; hook: PurgeHook }[];
}

/** A new, empty registry. */
export function createPurgeHookRegistry(): PurgeHookRegistry {
  const hooks: { name: string; hook: PurgeHook }[] = [];
  return {
    register(name, hook) {
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
        throw new TypeError(`registerPurgeHook: "${name}" is not a hook name`);
      }
      if (hooks.some((h) => h.name === name)) {
        throw new TypeError(`registerPurgeHook: "${name}" is already registered`);
      }
      hooks.push({ name, hook });
    },
    list: () => [...hooks],
  };
}

/** What the processor needs. */
export interface WorkspacePurgeDeps {
  hooks: PurgeHookRegistry;
  /** Hard-deletes a deleted workspace (@centcom/db `createWorkspaceStore(db)`). */
  store: { purge(workspaceId: string): Promise<{ purged: boolean }> };
  /** Announces the deletion again (B009 `RedisBackend.pubsub`). */
  events: Pick<PubSub, 'publish'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `workspace.purged`, `workspace.purge_hook_failed`, `.purge_retry` and `.purge_failed`. */
  logger?: Logger;
  /** Receives `workspace_purged_total` and `workspace_purge_failed_total`. */
  metrics?: Metrics;
}

/** The job as the processor reads it. */
export type WorkspacePurgeJob = Pick<Job<WorkspacePurgeJobData>, 'id' | 'data' | 'attemptsMade'>;

/**
 * Purges one deleted workspace: announce, hooks in order, then the rows. Throws (for BullMQ to
 * retry) when a hook or the store fails; an UnrecoverableError for a job without a workspace id.
 */
export async function processWorkspacePurge(
  job: WorkspacePurgeJob,
  deps: WorkspacePurgeDeps,
): Promise<{ purged: boolean; hooks: number }> {
  const { workspaceId } = job.data;
  if (!isId('wsp', workspaceId)) {
    throw new UnrecoverableError('workspace-purge: the job has no workspace id');
  }
  const now = (deps.clock ?? Date.now)();
  await publishWorkspaceDeleted(deps.events, workspaceId, new Date(now));
  const hooks = deps.hooks.list();
  for (const { name, hook } of hooks) {
    try {
      await hook(workspaceId, { now, attempt: job.attemptsMade + 1 });
    } catch (err) {
      deps.logger?.warn(
        {
          workspace_id: workspaceId,
          hook: name,
          error: err instanceof Error ? err.name : 'unknown',
        },
        'workspace.purge_hook_failed',
      );
      throw err;
    }
  }
  const { purged } = await deps.store.purge(workspaceId);
  if (purged) (deps.metrics ?? noopMetrics).counter('workspace_purged_total').inc();
  deps.logger?.info({ workspace_id: workspaceId, purged, hooks: hooks.length }, 'workspace.purged');
  return { purged, hooks: hooks.length };
}

/** The wait before retry `attemptsMade` (from 1): between half and all of `base · 2^(n-1)`, capped. */
export function workspacePurgeBackoff(
  baseMs: number = WORKSPACE_PURGE_BACKOFF_BASE_MS,
  random: () => number = Math.random,
): (attemptsMade: number) => number {
  return (attemptsMade) => {
    const ceiling = Math.min(
      WORKSPACE_PURGE_BACKOFF_MAX_MS,
      baseMs * 2 ** Math.max(0, attemptsMade - 1),
    );
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  };
}

/** After a failed attempt: logs a retry, or counts and logs the job once it is dead-lettered. */
export function onWorkspacePurgeFailed(
  job: Pick<Job<WorkspacePurgeJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<WorkspacePurgeDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  const fields = {
    workspace_id: isId('wsp', job.data.workspaceId) ? job.data.workspaceId : 'invalid',
    job_id: job.id ?? 'unknown',
    attempts: job.attemptsMade,
  };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? WORKSPACE_PURGE_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'workspace.purge_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('workspace_purge_failed_total').inc();
  deps.logger?.error(fields, 'workspace.purge_failed');
}

/** Where BullMQ keeps the queue: a Redis connection and a key prefix. */
export interface WorkspacePurgeQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `workspace-purge` queue, for the API (WorkspaceService's `purgeQueue`). */
export function createWorkspacePurgeQueue(
  options: WorkspacePurgeQueueOptions,
): Queue<WorkspacePurgeJobData> {
  return new Queue<WorkspacePurgeJobData>(WORKSPACE_PURGE_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: workspacePurgeJobOptions(),
  });
}

/** Options for `startWorkspacePurgeWorker`. */
export interface WorkspacePurgeWorkerOptions
  extends WorkspacePurgeQueueOptions, WorkspacePurgeDeps {
  /** Jobs processed at once; default 2. */
  concurrency?: number;
  /** The first retry's wait; default 10 s (tests shorten it). */
  backoffBaseMs?: number;
  /** Jitter source; default Math.random. */
  random?: () => number;
}

/** Starts a worker on the `workspace-purge` queue. Close it with `worker.close()`. */
export function startWorkspacePurgeWorker(
  options: WorkspacePurgeWorkerOptions,
): Worker<WorkspacePurgeJobData> {
  const backoff = workspacePurgeBackoff(options.backoffBaseMs, options.random);
  const worker = new Worker<WorkspacePurgeJobData>(
    WORKSPACE_PURGE_QUEUE,
    (job) => processWorkspacePurge(job, options),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: options.concurrency ?? 2,
      settings: { backoffStrategy: (attemptsMade) => backoff(attemptsMade) },
    },
  );
  worker.on('failed', (job, err) => onWorkspacePurgeFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) => options.logger?.error({ error: err.name }, 'workspace.worker_error'));
  return worker;
}
