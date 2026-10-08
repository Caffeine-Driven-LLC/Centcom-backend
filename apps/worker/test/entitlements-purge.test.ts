/**
 * The `entitlements` hook of the workspace purge (B069): it deletes the purged workspace's
 * entitlement row before B027's store removes the workspace, runs again harmlessly, and registers
 * once only.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  ENTITLEMENTS_PURGE_HOOK,
  processWorkspacePurge,
  registerEntitlementsPurgeHook,
} from '../src/index.js';

describe('the entitlements purge hook', () => {
  it("deletes a purged workspace's entitlements before the workspace row goes", async () => {
    const steps: string[] = [];
    const rows = new Set<string>();
    const hooks = createPurgeHookRegistry();
    registerEntitlementsPurgeHook(hooks, {
      deleteForWorkspace: (workspaceId) => {
        steps.push(`entitlements:${workspaceId}`);
        return Promise.resolve(rows.delete(workspaceId) ? 1 : 0);
      },
    });
    expect(hooks.list().map((h) => h.name)).toEqual([ENTITLEMENTS_PURGE_HOOK]);
    const workspaceId = newId('wsp');
    rows.add(workspaceId);
    const deps = {
      hooks,
      store: {
        purge: (id: string) => {
          steps.push(`purge:${id}`);
          // The foreign key: the workspace cannot go while its row is there.
          if (rows.has(id)) return Promise.reject(new Error('foreign key'));
          return Promise.resolve({ purged: true });
        },
      },
      events: { publish: () => Promise.resolve() },
      clock: () => Date.UTC(2026, 9, 8),
    };
    const job = { id: `purge-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 };
    await processWorkspacePurge(job, deps);
    // A second run (a retry) finds nothing left and still succeeds.
    await processWorkspacePurge({ ...job, attemptsMade: 1 }, deps);
    expect(steps).toEqual([
      `entitlements:${workspaceId}`,
      `purge:${workspaceId}`,
      `entitlements:${workspaceId}`,
      `purge:${workspaceId}`,
    ]);
    expect(() =>
      registerEntitlementsPurgeHook(hooks, { deleteForWorkspace: () => Promise.resolve(0) }),
    ).toThrow(TypeError);
  });
});
