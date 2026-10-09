/**
 * The `history` hook of B027's workspace purge (B055): purges the durable history of a purged
 * workspace's sessions (blobs first, then index rows) before the purge deletes the sessions,
 * whose rows the history references with ON DELETE RESTRICT. Idempotent, as hooks must be: a
 * session whose history is gone purges nothing. Account purges (B026) delete sole-member
 * workspaces through the same purge, so they are covered too.
 *
 * Owns: the hook. Must not: log anything but counts.
 */
import type { PurgeHookRegistry } from './workspace-purge.js';

/** The name of the workspace-purge hook that purges a workspace's session history. */
export const HISTORY_PURGE_HOOK = 'history';

/** Registers, on B027's purge hook registry, the hook purging a workspace's session history. */
export function registerHistoryPurgeHook(
  hooks: PurgeHookRegistry,
  /** The API's `createWorkspaceHistoryPurger({db, store})`. */
  history: { purgeWorkspace(workspaceId: string): Promise<unknown> },
): void {
  hooks.register(HISTORY_PURGE_HOOK, async (workspaceId) => {
    await history.purgeWorkspace(workspaceId);
  });
}
