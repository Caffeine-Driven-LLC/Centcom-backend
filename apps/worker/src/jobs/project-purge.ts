/**
 * The `projects` hook of B027's workspace purge (B035): deletes a purged workspace's projects
 * before the workspace row goes (the foreign key restricts). Idempotent, as hooks must be: the
 * store deletes nothing for a workspace that is live or already empty.
 *
 * Owns: the hook. Must not: log a project's name or repository reference.
 */
import type { PurgeHookRegistry } from './workspace-purge.js';

/** The name of the workspace-purge hook that deletes a purged workspace's projects. */
export const PROJECT_PURGE_HOOK = 'projects';

/** Registers, on B027's purge hook registry, the hook deleting a purged workspace's projects. */
export function registerProjectPurgeHook(
  hooks: PurgeHookRegistry,
  /** @centcom/db `createProjectStore(db)`. */
  store: { deleteForWorkspace(workspaceId: string): Promise<number> },
): void {
  hooks.register(PROJECT_PURGE_HOOK, async (workspaceId) => {
    await store.deleteForWorkspace(workspaceId);
  });
}
