/**
 * Times the release endpoints from the memory cache (B084 acceptance 4: p95 ≤ 30 ms).
 * releases.perf.test.ts runs this in a separate Node process (tsx's CLI with tsconfig.test.json,
 * so no build is needed): test workers run under coverage instrumentation and share their thread
 * with other test files. Twenty releases per channel; after a warm-up, three rounds of 200
 * requests alternating `latest` and `manifest.json`; writes `{p95s, loads}` as JSON to stdout
 * (`loads`: repository reads during the timed rounds).
 */
import { performance } from 'node:perf_hooks';
import { get, manifest, releasesApp, T0 } from './helpers.js';

const ROUNDS = 3;
const PER_ROUND = 200;

const t = await releasesApp();
for (const channel of ['stable', 'beta', 'nightly'] as const) {
  for (let i = 0; i < 20; i += 1) {
    const version = channel === 'stable' ? `1.${i}.0` : `2.0.0-${channel}.${i}`;
    await t.publisher.publishRelease(
      manifest(t.key, { channel, version, released_at: new Date(T0 + i * 1000).toISOString() }),
      { kind: 'system', name: 'bench' },
    );
  }
}
await t.cache.refresh();
const urls = [
  '/v1/releases/stable/latest?platform=darwin&arch=arm64',
  '/v1/releases/beta/manifest.json',
];
for (let i = 0; i < 50; i += 1) await get(t.app, urls[i % 2] ?? '');
const loadsBefore = t.repo.loads;
const p95s: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < PER_ROUND; i += 1) {
    const started = performance.now();
    const res = await get(t.app, urls[i % 2] ?? '');
    samples.push(performance.now() - started);
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  }
  samples.sort((a, b) => a - b);
  p95s.push(samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY);
}
const loads = t.repo.loads - loadsBefore;
await t.app.close();
process.stdout.write(JSON.stringify({ p95s, loads }));
