/**
 * The worker's job services (B109): built from the API's context, the purge hooks a deleted
 * workspace runs (the history hook only with an object store), the sweeps that need the session
 * routes, and the purge queue the API hands to the workspace service. The database here is a pool
 * that never connects; nothing needs a server.
 */
import { createDb, closeDb } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase } from '../../src/context.js';
import { createJobServices } from '../../src/jobs.js';
import { captureLogger } from '../helpers.js';
import { memoryRedis, testEnv } from './helpers.js';

function services(env: Record<string, string | undefined> = {}, purgeQueue?: { add: unknown }) {
  const captured = captureLogger();
  const db = createDb<ApiDatabase>({
    url: 'postgres://centcom:test@127.0.0.1:1/none',
    poolMax: 1,
    connectTimeoutMs: 300,
  });
  const ctx = createContext({
    config: loadApiConfig(testEnv(env)),
    db,
    redis: memoryRedis(),
    logger: captured.logger,
    ...(purgeQueue === undefined ? {} : { purgeQueue: purgeQueue as never }),
  });
  return { ctx, jobs: createJobServices(ctx), captured, close: () => closeDb(db) };
}

const OBJECT_STORE = {
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9',
  OBJECT_STORE_BUCKET: 'history',
  OBJECT_STORE_ACCESS_KEY_ID: 'k',
  OBJECT_STORE_SECRET_ACCESS_KEY: 's',
};

describe('the worker job services', () => {
  it('purges a workspace through five hooks with an object store, four without (with a log line)', async () => {
    const withStore = services(OBJECT_STORE);
    expect(withStore.jobs.hooks.list().map((h) => h.name)).toEqual(
      expect.arrayContaining([
        'invites',
        'entitlements',
        'projects',
        'workspace-settings',
        'history',
      ]),
    );
    expect(withStore.jobs.hooks.list()).toHaveLength(5);
    await withStore.close();

    const without = services();
    expect(without.jobs.hooks.list().map((h) => h.name)).not.toContain('history');
    expect(without.jobs.hooks.list()).toHaveLength(4);
    expect(without.captured.lines().some((l) => l['msg'] === 'worker.purge_hook_skipped')).toBe(
      true,
    );
    await without.close();
  });

  it('sweeps sessions and share links when the session routes are on, and not otherwise', async () => {
    const on = services();
    expect(on.jobs.sessions).not.toBeNull();
    expect(on.jobs.shareLinks).not.toBeNull();
    await on.close();
    const off = services({ RELAY_PUBLIC_URL: undefined });
    expect(off.jobs.sessions).toBeNull();
    expect(off.jobs.shareLinks).toBeNull();
    await off.close();
  });

  it('builds with a purge queue given (the workspace service uses it instead of the log-only stub)', async () => {
    const added: unknown[] = [];
    const { ctx, close } = services(
      {},
      {
        add: (...args: unknown[]) => {
          added.push(args);
          return Promise.resolve();
        },
      },
    );
    expect(ctx.collab.workspaces).toBeDefined();
    expect(added).toEqual([]);
    await close();
  });
});
