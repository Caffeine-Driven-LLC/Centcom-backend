/**
 * Workspace lifecycle names (B027) shared by the API, which deletes workspaces, and the worker,
 * which purges them: the Redis channel `workspace.deleted` is announced on, and the
 * `workspace-purge` queue with its job options.
 *
 * Owns: the channel, the message shape, the queue name and the job options. Must not: carry
 * anything but ids and times in a message or a job.
 */
import type { PubSub } from '../redis/types.js';

/** Redis pub/sub channel of workspace lifecycle events (the relay drops a deleted workspace's sessions). */
export const WORKSPACE_EVENTS_CHANNEL = 'centcom:workspace-events';

/** `workspace.deleted`: the workspace `wsp` was deleted at `at` (RFC 3339). */
export interface WorkspaceDeletedEvent {
  type: 'workspace.deleted';
  wsp: string;
  at: string;
}

/** Announces that `workspaceId` was deleted at `at`; rejects when Redis does. */
export function publishWorkspaceDeleted(
  pubsub: Pick<PubSub, 'publish'>,
  workspaceId: string,
  at: Date,
): Promise<void> {
  const event: WorkspaceDeletedEvent = {
    type: 'workspace.deleted',
    wsp: workspaceId,
    at: at.toISOString(),
  };
  return pubsub.publish(WORKSPACE_EVENTS_CHANNEL, JSON.stringify(event));
}

/** The BullMQ queue that purges deleted workspaces. */
export const WORKSPACE_PURGE_QUEUE = 'workspace-purge';
/** A purge job is tried this many times, then left in the failed (dead-letter) set. */
export const WORKSPACE_PURGE_ATTEMPTS = 5;
/** The custom backoff the purge worker computes (BullMQ routes it to `settings.backoffStrategy`). */
export const WORKSPACE_PURGE_BACKOFF_TYPE = 'workspace-purge';
/** Dead-lettered purge jobs are kept this long, in seconds (7 days), for an operator to look at. */
export const WORKSPACE_PURGE_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** What a purge job carries. */
export interface WorkspacePurgeJobData {
  workspaceId: string;
}

/**
 * One purge job per workspace: adding it again while it exists does nothing. BullMQ rejects ":" in
 * custom job ids, so the separator is "-".
 */
export const workspacePurgeJobId = (workspaceId: string): string => `purge-${workspaceId}`;

/** Options of a purge job: 5 attempts with the worker's backoff, dead letters kept 7 days. */
export function workspacePurgeJobOptions(): {
  attempts: number;
  backoff: { type: string };
  removeOnComplete: true;
  removeOnFail: { age: number };
} {
  return {
    attempts: WORKSPACE_PURGE_ATTEMPTS,
    backoff: { type: WORKSPACE_PURGE_BACKOFF_TYPE },
    removeOnComplete: true,
    removeOnFail: { age: WORKSPACE_PURGE_FAILED_RETENTION_S },
  };
}
