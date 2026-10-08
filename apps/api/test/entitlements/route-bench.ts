/**
 * Times `GET /v1/workspaces/{id}/entitlements` with a warm B080 cache (acceptance 2: p95 ≤ 50 ms).
 * entitlements.cached-route.test.ts runs this in a separate Node process (tsx's CLI with
 * tsconfig.test.json, so no build is needed): test workers run under coverage instrumentation and
 * share their thread with other test files. After a warm-up, three rounds of 200 requests; writes
 * `{ p95s, sqlReads }` (milliseconds, one per round; source reads during the timed rounds) as JSON
 * to stdout.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { asUser, createWorkspace } from '../modules/workspaces/helpers.js';
import { cachedApp } from './cached-app.js';

const ROUNDS = 3;
const PER_ROUND = 200;

const t = await cachedApp();
const owner = newId('usr');
t.store.addUser(owner);
const ws = (await createWorkspace(t.app, owner)).id;
const url = `/v1/workspaces/${ws}/entitlements`;
const headers = asUser(owner);
for (let i = 0; i < 50; i += 1) await t.app.inject({ method: 'GET', url, headers });
const readsBefore = t.reads();
const p95s: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < PER_ROUND; i += 1) {
    const started = performance.now();
    const res = await t.app.inject({ method: 'GET', url, headers });
    samples.push(performance.now() - started);
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  }
  samples.sort((a, b) => a - b);
  p95s.push(samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY);
}
await t.app.close();
process.stdout.write(JSON.stringify({ p95s, sqlReads: t.reads() - readsBefore }));
