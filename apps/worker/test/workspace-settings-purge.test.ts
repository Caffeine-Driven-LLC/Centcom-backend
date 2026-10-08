/**
 * The settings purge hook (B034): registered on B027's purge registry as `workspace-settings`, it
 * deletes a purged workspace's settings before the workspace row goes, and runs again harmlessly.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  processWorkspacePurge,
  registerWorkspaceSettingsPurgeHook,
  WORKSPACE_SETTINGS_PURGE_HOOK,
} from '../src/index.js';

describe('registerWorkspaceSettingsPurgeHook', () => {
  it("deletes a purged workspace's settings before the workspace row, idempotently", async () => {
    const steps: string[] = [];
    const rows = new Set<string>();
    const hooks = createPurgeHookRegistry();
    registerWorkspaceSettingsPurgeHook(hooks, {
      deleteForWorkspace: (workspaceId) => {
        const had = rows.delete(workspaceId);
        steps.push(`settings:${workspaceId}:${had ? 1 : 0}`);
        return Promise.resolve(had ? 1 : 0);
      },
    });
    expect(hooks.list().map((h) => h.name)).toEqual([WORKSPACE_SETTINGS_PURGE_HOOK]);
    const workspaceId = newId('wsp');
    rows.add(workspaceId);
    const deps = {
      hooks,
      store: {
        purge: (id: string) => {
          steps.push(`purge:${id}`);
          return Promise.resolve({ purged: true });
        },
      },
      events: { publish: () => Promise.resolve() },
      clock: () => Date.UTC(2026, 9, 7, 12, 0, 0),
    };
    const job = { id: `purge-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 };
    await processWorkspacePurge(job, deps);
    await processWorkspacePurge(job, deps);
    expect(steps).toEqual([
      `settings:${workspaceId}:1`,
      `purge:${workspaceId}`,
      `settings:${workspaceId}:0`,
      `purge:${workspaceId}`,
    ]);
  });

  it('refuses a second registration under the same name', () => {
    const hooks = createPurgeHookRegistry();
    const store = { deleteForWorkspace: () => Promise.resolve(0) };
    registerWorkspaceSettingsPurgeHook(hooks, store);
    expect(() => registerWorkspaceSettingsPurgeHook(hooks, store)).toThrow(TypeError);
  });
});
