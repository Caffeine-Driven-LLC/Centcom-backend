/**
 * Times the API with and without telemetry (B093: p95 regression at most 5 % with tracing at 5 %
 * sampling). otel.perf.test.ts runs this in a separate Node process (tsx's CLI with
 * tsconfig.test.json): test workers run under coverage instrumentation and share their thread.
 *
 * Two apps answer the same route with the same work (hashing, about 2.5 ms, a modest API call): the
 * baseline with the request context plugin and no-op metrics; the instrumented one recording through
 * the catalogue bridge and tracing every request at OTEL_SAMPLE_RATIO 0.05, with real OTLP/HTTP
 * exporters pointed at a collector that accepts connections and never answers (so this is also the
 * "collector down" case). After a warm-up, rounds alternate between the two, in blocks of four;
 * each block gives a p95 ratio (instrumented over baseline) and the median of the blocks' ratios is
 * the result, which a stray pause in one block cannot move. Writes `{ratio, ratios, baseline,
 * instrumented, shutdownMs}` (p95s pooled, milliseconds) as JSON to stdout.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { createLogger, initTelemetry, noopMetrics, type Metrics } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { telemetryPlugin } from '../../src/plugins/telemetry.js';

const PAYLOAD = Buffer.alloc(512 * 1024, 7);
const HASHES = 8;
const BLOCKS = 6;
const ROUNDS_PER_BLOCK = 4;
const PER_ROUND = 150;

const hole = createServer(() => undefined);
await new Promise<void>((resolve) => hole.listen(0, '127.0.0.1', resolve));
const address = hole.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

const telemetry = initTelemetry({
  service: 'api',
  version: 'bench',
  env: 'bench',
  config: { enabled: true, endpoint: `http://127.0.0.1:${port}`, sampleRatio: 0.05 },
  metricIntervalMs: 1000,
});

async function app(metrics: Metrics, traced: boolean): Promise<FastifyInstance> {
  const logger = createLogger({
    level: 'info',
    service: 'bench',
    version: 'bench',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const a = fastify({ logger: false });
  await a.register(requestContextPlugin, { logger, metrics });
  await a.register(errorHandlerPlugin, { logger });
  if (traced) await a.register(telemetryPlugin, { tracer: telemetry.tracer });
  a.get('/v1/work/:id', async (request) => {
    let digest = '';
    for (let i = 0; i < HASHES; i += 1) {
      digest = createHash('sha256').update(PAYLOAD).update(digest).digest('hex');
    }
    return { id: (request.params as { id: string }).id, digest };
  });
  await a.ready();
  return a;
}

const baseline = await app(noopMetrics, false);
const instrumented = await app(telemetry.metrics, true);

async function round(target: FastifyInstance, into: number[]): Promise<void> {
  for (let i = 0; i < PER_ROUND; i += 1) {
    const started = performance.now();
    const res = await target.inject({ method: 'GET', url: `/v1/work/item-${i}` });
    into.push(performance.now() - started);
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  }
}

const warm: number[] = [];
for (let i = 0; i < 3; i += 1) {
  await round(baseline, warm);
  await round(instrumented, warm);
}
const p95 = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
};
const all = { baseline: [] as number[], instrumented: [] as number[] };
const ratios: number[] = [];
for (let b = 0; b < BLOCKS; b += 1) {
  const block = { baseline: [] as number[], instrumented: [] as number[] };
  for (let r = 0; r < ROUNDS_PER_BLOCK; r += 1) {
    if (r % 2 === 0) {
      await round(baseline, block.baseline);
      await round(instrumented, block.instrumented);
    } else {
      await round(instrumented, block.instrumented);
      await round(baseline, block.baseline);
    }
  }
  ratios.push(p95(block.instrumented) / p95(block.baseline));
  all.baseline.push(...block.baseline);
  all.instrumented.push(...block.instrumented);
}
const sortedRatios = [...ratios].sort((a, b) => a - b);
const ratio = ((sortedRatios[BLOCKS / 2 - 1] ?? 0) + (sortedRatios[BLOCKS / 2] ?? 0)) / 2;
await baseline.close();
await instrumented.close();
const stopping = performance.now();
await telemetry.shutdown();
const shutdownMs = performance.now() - stopping;
hole.close();
process.stdout.write(
  JSON.stringify({
    ratio,
    ratios,
    baseline: p95(all.baseline),
    instrumented: p95(all.instrumented),
    shutdownMs,
  }),
);
process.exit(0);
