/**
 * The services of what a session leaves behind and what a workspace uses (B107), built from the
 * API's context: with an object store the history and snapshot services exist, without one they
 * are null (their routes are left out with a log line, see app.build.test.ts); usage and
 * preferences are always there. The database here is a pool that never connects.
 */
import { createDb, closeDb } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase } from '../../src/context.js';
import { captureLogger } from '../helpers.js';
import { memoryRedis, testEnv } from './helpers.js';

function context(env: Record<string, string | undefined> = {}) {
  const db = createDb<ApiDatabase>({
    url: 'postgres://centcom:test@127.0.0.1:1/none',
    poolMax: 1,
    connectTimeoutMs: 300,
  });
  const ctx = createContext({
    config: loadApiConfig(testEnv(env)),
    db,
    redis: memoryRedis(),
    logger: captureLogger().logger,
  });
  return { ctx, close: () => closeDb(db) };
}

const STORE = {
  OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9',
  OBJECT_STORE_BUCKET: 'history',
  OBJECT_STORE_ACCESS_KEY_ID: 'k',
  OBJECT_STORE_SECRET_ACCESS_KEY: 's',
};

describe('the data services', () => {
  it('has history and snapshots with an object store, and always usage and preferences', async () => {
    const { ctx, close } = context(STORE);
    expect(ctx.config.objectStore?.bucket).toBe('history');
    expect(ctx.data.history).not.toBeNull();
    expect(ctx.data.snapshots).not.toBeNull();
    expect(ctx.data.usageIngest).toBeDefined();
    expect(ctx.data.usageSummary).toBeDefined();
    expect(ctx.data.preferences).toBeDefined();
    await close();
  });

  it('has no history or snapshots without an object store, but usage and preferences', async () => {
    const { ctx, close } = context();
    expect(ctx.config.objectStore).toBeNull();
    expect(ctx.data.history).toBeNull();
    expect(ctx.data.snapshots).toBeNull();
    expect(ctx.data.usageIngest).toBeDefined();
    await close();
  });

  it('refuses a half-set object store, naming the keys and never their values', () => {
    let message = '';
    try {
      loadApiConfig(
        testEnv({ OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9', OBJECT_STORE_BUCKET: 'history' }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('OBJECT_STORE_ACCESS_KEY_ID');
    expect(message).not.toContain('127.0.0.1:9');
  });
});
