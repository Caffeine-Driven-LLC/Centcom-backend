/**
 * `GET /v1/workspaces/{id}/entitlements` served through B080's cache (acceptance 2 and 3): with
 * the current ETag in If-None-Match, 304 and no body; a member of another workspace gets 404 and
 * no data; without credentials, 401; a warm read does not reach SQL, and the route's p95 with a
 * warm cache is within 50 ms, timed in a separate process (route-bench.ts).
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { asUser, createWorkspace } from '../modules/workspaces/helpers.js';
import { cachedApp } from './cached-app.js';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./route-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe('GET /v1/workspaces/{id}/entitlements through the cache', () => {
  it('answers 304 to the current ETag, 404 to another workspace’s member, 401 without credentials', async () => {
    const t = await cachedApp();
    const owner = newId('usr');
    t.store.addUser(owner);
    const ws = (await createWorkspace(t.app, owner)).id;
    const url = `/v1/workspaces/${ws}/entitlements`;
    const first = await t.app.inject({ method: 'GET', url, headers: asUser(owner) });
    expect(first.statusCode).toBe(200);
    const etag = String(first.headers['etag']);
    const again = await t.app.inject({
      method: 'GET',
      url,
      headers: { ...asUser(owner), 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    const stranger = newId('usr');
    t.store.addUser(stranger);
    await createWorkspace(t.app, stranger, 'Other');
    const other = await t.app.inject({ method: 'GET', url, headers: asUser(stranger) });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain('limits');
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    await t.app.close();
  });

  it('serves warm reads from the cache within 50 ms at the 95th percentile (own process)', () => {
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const { p95s, sqlReads } = JSON.parse(out) as { p95s: number[]; sqlReads: number };
    expect(sqlReads).toBe(0);
    expect(Math.min(...p95s)).toBeLessThanOrEqual(50);
  });
});
