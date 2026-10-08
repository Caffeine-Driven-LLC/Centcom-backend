/**
 * The `projects` hook of the workspace purge (B035, card test projects.purge-hook.test.ts): it is
 * registered under its name, runs before the workspace row goes, and a re-run of the job is
 * harmless. The rows really going (count 0 after a workspace deletion) is checked on Postgres in
 * apps/api/test/modules/projects/projects.postgres.test.ts.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  PROJECT_PURGE_HOOK,
  processWorkspacePurge,
  registerProjectPurgeHook,
} from '../src/index.js';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe('the projects purge hook', () => {
  it('deletes a purged workspace’s projects before the workspace row goes, idempotently', async () => {
    const steps: string[] = [];
    const remaining = new Map<string, number>();
    const hooks = createPurgeHookRegistry();
    registerProjectPurgeHook(hooks, {
      deleteForWorkspace: (workspaceId) => {
        steps.push(`projects:${workspaceId}`);
        const n = remaining.get(workspaceId) ?? 0;
        remaining.set(workspaceId, 0);
        return Promise.resolve(n);
      },
    });
    expect(hooks.list().map((h) => h.name)).toEqual([PROJECT_PURGE_HOOK]);
    expect(PROJECT_PURGE_HOOK).toBe('projects');

    const workspaceId = newId('wsp');
    remaining.set(workspaceId, 3);
    const deps = {
      hooks,
      store: {
        purge: (id: string) => {
          steps.push(`purge:${id}`);
          return Promise.resolve({ purged: true });
        },
      },
      events: { publish: () => Promise.resolve() },
      clock: () => NOW,
    };
    const job = { id: `purge-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 };
    await processWorkspacePurge(job, deps);
    expect(steps).toEqual([`projects:${workspaceId}`, `purge:${workspaceId}`]);
    expect(remaining.get(workspaceId)).toBe(0);

    // A re-run (a retry after a partial failure) is harmless.
    await processWorkspacePurge({ ...job, attemptsMade: 1 }, deps);
    expect(steps.slice(2)).toEqual([`projects:${workspaceId}`, `purge:${workspaceId}`]);
  });

  it('cannot be registered twice', () => {
    const hooks = createPurgeHookRegistry();
    const store = { deleteForWorkspace: () => Promise.resolve(0) };
    registerProjectPurgeHook(hooks, store);
    expect(() => registerProjectPurgeHook(hooks, store)).toThrow(/already registered/);
  });
});
