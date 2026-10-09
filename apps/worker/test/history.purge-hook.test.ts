/**
 * The `history` hook of the workspace purge (B055): it is registered under its name, purges the
 * workspace's session history before the workspace row (and its sessions) go, and a re-run of the
 * job is harmless. That B027's real purge then succeeds against the history tables' foreign keys
 * is checked on Postgres in apps/api/test/history/history.purge.test.ts.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  HISTORY_PURGE_HOOK,
  processWorkspacePurge,
  registerHistoryPurgeHook,
} from '../src/index.js';

describe('the history purge hook', () => {
  it('purges a workspace’s session history before the workspace row goes, idempotently', async () => {
    const steps: string[] = [];
    const hooks = createPurgeHookRegistry();
    registerHistoryPurgeHook(hooks, {
      purgeWorkspace: (workspaceId) => {
        steps.push(`history:${workspaceId}`);
        return Promise.resolve({ sessions: 1, frames: 0 });
      },
    });
    expect(hooks.list().map((h) => h.name)).toEqual([HISTORY_PURGE_HOOK]);
    const workspaceId = newId('wsp');
    const deps = {
      hooks,
      store: {
        purge: (id: string) => {
          steps.push(`purge:${id}`);
          return Promise.resolve({ purged: true });
        },
      },
      events: { publish: () => Promise.resolve() },
      clock: () => 0,
    };
    const job = { id: `purge-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 };
    await processWorkspacePurge(job, deps);
    await processWorkspacePurge({ ...job, attemptsMade: 1 }, deps);
    expect(steps).toEqual([
      `history:${workspaceId}`,
      `purge:${workspaceId}`,
      `history:${workspaceId}`,
      `purge:${workspaceId}`,
    ]);
    expect(() =>
      registerHistoryPurgeHook(hooks, { purgeWorkspace: () => Promise.resolve() }),
    ).toThrow(/already registered/);
  });
});
