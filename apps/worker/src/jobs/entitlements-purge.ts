/**
 * The `entitlements` hook of B027's workspace purge (B069): deletes a purged workspace's
 * entitlement row before the workspace row goes (its foreign key restricts the delete).
 * Idempotent: a second run finds nothing to delete.
 *
 * Owns: the hook. Must not: touch a live workspace's row (the repository deletes only those of a
 * deleted workspace).
 */
import type { PurgeHookRegistry } from './workspace-purge.js';

/** The name of the workspace-purge hook that deletes a purged workspace's entitlements. */
export const ENTITLEMENTS_PURGE_HOOK = 'entitlements';

/** Registers, on B027's purge hook registry, the hook deleting a purged workspace's entitlements. */
export function registerEntitlementsPurgeHook(
  hooks: PurgeHookRegistry,
  /** @centcom/api's `createEntitlementRepository(db)`. */
  repository: { deleteForWorkspace(workspaceId: string): Promise<number> },
): void {
  hooks.register(ENTITLEMENTS_PURGE_HOOK, async (workspaceId) => {
    await repository.deleteForWorkspace(workspaceId);
  });
}
