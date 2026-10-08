/**
 * The `workspace-settings` hook of B027's workspace purge (B034): deletes a purged workspace's
 * settings row before the workspace row goes (its foreign key restricts the delete). Idempotent:
 * a second run finds nothing to delete.
 *
 * Owns: the hook. Must not: touch a live workspace's settings (the store deletes only those of a
 * deleted workspace).
 */
import type { PurgeHookRegistry } from './workspace-purge.js';

/** The name of the workspace-purge hook that deletes a purged workspace's settings. */
export const WORKSPACE_SETTINGS_PURGE_HOOK = 'workspace-settings';

/** Registers, on B027's purge hook registry, the hook deleting a purged workspace's settings. */
export function registerWorkspaceSettingsPurgeHook(
  hooks: PurgeHookRegistry,
  /** @centcom/db `createWorkspaceSettingsStore(db)`. */
  store: { deleteForWorkspace(workspaceId: string): Promise<number> },
): void {
  hooks.register(WORKSPACE_SETTINGS_PURGE_HOOK, async (workspaceId) => {
    await store.deleteForWorkspace(workspaceId);
  });
}
