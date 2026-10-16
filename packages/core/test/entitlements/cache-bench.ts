/**
 * Times EntitlementCache hits (B080 acceptance 2: p99 under 1 ms). cache.test.ts runs this in a
 * separate Node process, as redact-bench.ts does: test workers run under coverage instrumentation
 * and share their thread with other test files. 1 000 workspaces are cached; after a warm-up, three
 * rounds of 10 000 hits on random workspaces, each hit timed alone; writes `{ p99s }`
 * (milliseconds, one per round) as JSON to stdout.
 */
import { performance } from 'node:perf_hooks';
import { EntitlementCache } from '../../src/entitlements/cache.js';

const WORKSPACES = 1_000;
const ROUNDS = 3;
const PER_ROUND = 10_000;

const cache = new EntitlementCache<{ rev: number }>({
  load: () => Promise.resolve({ rev: 1 }),
  clock: () => 0,
});
const ids = Array.from({ length: WORKSPACES }, (_, i) => `wsp_${String(i).padStart(26, '0')}`);
for (const id of ids) await cache.get(id);
for (let i = 0; i < PER_ROUND; i += 1) await cache.get(ids[i % WORKSPACES] ?? '');

const p99s: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < PER_ROUND; i += 1) {
    const id = ids[Math.floor(Math.random() * WORKSPACES)] ?? '';
    const started = performance.now();
    await cache.get(id);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  p99s.push(samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY);
}
process.stdout.write(JSON.stringify({ p99s }));
