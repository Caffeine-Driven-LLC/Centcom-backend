/**
 * Times `GET /healthz` (B086 acceptance 1: under 5 ms at the 99th percentile), with Postgres and
 * Redis down so nothing it might touch is fast. status.perf.test.ts runs this in a separate Node
 * process (tsx's CLI with tsconfig.test.json): test workers run under coverage instrumentation and
 * share their thread with other test files. After a warm-up, three rounds of 1 000 requests; writes
 * `{p99s}` (milliseconds) as JSON to stdout.
 */
import { performance } from 'node:perf_hooks';
import { statusWorld } from './helpers.js';

const world = statusWorld([{ id: 'api', name: 'API', probe: null }]);
world.db.mode = 'down';
world.redisMode.mode = 'down';
world.repo.down = true;
const instance = await world.instance();
for (let i = 0; i < 200; i += 1) await instance.app.inject({ method: 'GET', url: '/healthz' });
const p99s: number[] = [];
for (let round = 0; round < 3; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const started = performance.now();
    const res = await instance.app.inject({ method: 'GET', url: '/healthz' });
    samples.push(performance.now() - started);
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  }
  samples.sort((a, b) => a - b);
  p99s.push(samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY);
}
await world.close();
process.stdout.write(JSON.stringify({ p99s }));
