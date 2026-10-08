/**
 * The telemetry bootstrap (B093) with in-memory exporters:
 *
 * - configuration: on by default, off with OTEL_ENABLED=false and always under tests;
 * - spans are redacted before any exporter sees them (authorization, cookie, ct, p, ticket, token,
 *   the client's address; ids, e-mail and IP addresses in values), request ids kept;
 * - a job execution is a span whose trace id is in the log lines written while it runs, with the
 *   job metrics; a failure is counted and marks the span, by error name only;
 * - the queue, pool and Redis hooks;
 * - a collector that refuses or never answers: telemetry is dropped and counted
 *   (`otel_export_failed_total`), the code being measured is not slowed, and shutdown still
 *   finishes within 5 s.
 */
import { createServer, type Server } from 'node:net';
import { Writable } from 'node:stream';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  createMemoryRedis,
  initTelemetry,
  loadOtelConfig,
  observeDbPool,
  observeQueues,
  runWithContext,
  sampleRedisLatency,
  SHUTDOWN_TIMEOUT_MS,
  SPAN_QUEUE_MAX,
  traceJob,
  type Telemetry,
} from '../../src/index.js';
import { points, type Point } from './helpers.js';

const ON = { enabled: true, endpoint: 'http://127.0.0.1:9', sampleRatio: 1 };
const opened: Telemetry[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.shutdown();
});

function telemetry(over: Partial<Parameters<typeof initTelemetry>[0]> = {}) {
  const spans = new InMemorySpanExporter();
  const metricsOut = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const t = initTelemetry({
    service: 'worker',
    version: '1.2.3',
    env: 'test',
    region: 'eu',
    config: ON,
    traceExporter: spans,
    metricExporter: metricsOut,
    metricIntervalMs: 60_000,
    strict: true,
    ...over,
  });
  opened.push(t);
  const exported = (): Point[] => metricsOut.getMetrics().flatMap(points);
  return { t, spans, exported };
}

/** A logger writing JSON lines into `lines`. */
function captured(): {
  logger: ReturnType<typeof createLogger>;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'info',
    service: 'test',
    version: '0',
    env: 'test',
    destination: new Writable({
      write(chunk: Buffer, _e, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
  });
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('configuration', () => {
  it('is on by default, off with OTEL_ENABLED=false, and never on under tests', () => {
    expect(loadOtelConfig({})).toEqual({
      enabled: true,
      endpoint: 'http://localhost:4318',
      sampleRatio: 0.05,
    });
    expect(loadOtelConfig({ OTEL_ENABLED: 'false' }).enabled).toBe(false);
    expect(loadOtelConfig({ NODE_ENV: 'test', OTEL_ENABLED: 'true' }).enabled).toBe(false);
    expect(loadOtelConfig({ VITEST: 'true' }).enabled).toBe(false);
    expect(
      loadOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal:4318/',
        OTEL_SAMPLE_RATIO: '0.25',
      }),
    ).toMatchObject({ endpoint: 'https://collector.internal:4318', sampleRatio: 0.25 });
    expect(() => loadOtelConfig({ OTEL_SAMPLE_RATIO: '1.5' })).toThrow(/OTEL_SAMPLE_RATIO/);
    expect(() => loadOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://x' })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
    // The process running these tests: off, whatever its environment says.
    expect(loadOtelConfig().enabled).toBe(false);
  });

  it('when off, records nothing and exports nothing, but still checks the catalogue', async () => {
    const t = initTelemetry({
      service: 'api',
      version: '1',
      env: 'dev',
      config: { ...ON, enabled: false },
      strict: true,
    });
    expect(t.enabled).toBe(false);
    t.metrics
      .counter('http_requests_total', { route: '/', method: 'GET', status_class: '2xx' })
      .inc();
    expect(() => t.metrics.counter('made_up_total')).toThrow(/uncatalogued/);
    const span = t.tracer.startSpan('x');
    expect(span.isRecording()).toBe(false);
    span.end();
    await t.flush();
    await t.shutdown();
  });
});

describe('spans', () => {
  it('are redacted before export, keeping request ids', async () => {
    const { t, spans } = telemetry();
    const span = t.tracer.startSpan('GET /v1/users/:id', {
      attributes: {
        'http.route': '/v1/users/:id',
        'centcom.request_id': 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        authorization: 'Bearer abc.def.ghi',
        'http.request.header.authorization': 'Bearer abc',
        cookie: 'session=1',
        ct: 'ciphertext',
        p: 'plaintext',
        ticket: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln',
        token: 'cen_live_abc',
        'client.address': '203.0.113.9',
        'net.peer.ip': '203.0.113.9',
        'db.password': 'hunter2',
        'centcom.note': 'user usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W (alice@example.com) from 10.1.2.3',
      },
    });
    span.addEvent('retry', { 'centcom.workspace': 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed for alice@example.com' });
    span.end();
    await t.flush();
    const [got] = spans.getFinishedSpans();
    expect(got?.attributes).toEqual({
      'http.route': '/v1/users/:id',
      'centcom.request_id': 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      'centcom.note': 'user usr_[id] ([email]) from [ip]',
    });
    expect(got?.events[0]?.attributes).toEqual({ 'centcom.workspace': 'wsp_[id]' });
    expect(got?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(got?.resource.attributes).toMatchObject({
      'service.name': 'centcom-worker',
      'service.version': '1.2.3',
      'deployment.environment.name': 'test',
      'cloud.region': 'eu',
    });
    expect(SPAN_QUEUE_MAX).toBe(2048);
  });
});

describe('jobs', () => {
  it('traces a job execution, with its trace id in the log lines it writes, and measures it', async () => {
    const { t, spans, exported } = telemetry();
    const { logger, lines } = captured();
    const result = await traceJob(t, 'email.send', () => {
      logger.info({ template: 'magic_link' }, 'email.sent');
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    await expect(
      traceJob(t, 'email.send', () =>
        Promise.reject(new TypeError('provider said no to bob@example.com')),
      ),
    ).rejects.toThrow(TypeError);
    // Inside a request's context, the job keeps the request id and adds the trace id.
    await runWithContext({ requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W' }, () =>
      traceJob(t, 'notify.dispatch', () => {
        logger.info({}, 'notify.sent');
        return Promise.resolve();
      }),
    );
    await t.flush();
    const finished = spans.getFinishedSpans();
    expect(finished.map((s) => [s.name, s.status.code])).toEqual([
      ['job email.send', SpanStatusCode.OK],
      ['job email.send', SpanStatusCode.ERROR],
      ['job notify.dispatch', SpanStatusCode.OK],
    ]);
    expect(finished[1]?.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify(finished)).not.toContain('bob@example.com');
    const [sent, notify] = lines();
    expect(sent?.['trace_id']).toBe(finished[0]?.spanContext().traceId);
    expect(sent?.['request_id']).toMatch(/^req_/);
    expect(notify).toMatchObject({
      request_id: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      trace_id: finished[2]?.spanContext().traceId,
    });
    const got = exported();
    expect(got.find((p) => p.name === 'centcom_job_failed_total')).toMatchObject({
      attributes: { queue: 'email.send' },
      value: 1,
    });
    expect(
      got
        .filter((p) => p.name === 'centcom_job_duration_seconds')
        .map((p) => [p.attributes['queue'], p.value]),
    ).toEqual(
      expect.arrayContaining([
        ['email.send', 2],
        ['notify.dispatch', 1],
      ]),
    );
  });

  it('does not put a trace id in the logs of an unsampled job', async () => {
    const { t } = telemetry({ config: { ...ON, sampleRatio: 0 } });
    const { logger, lines } = captured();
    await traceJob(t, 'email.send', () => {
      logger.info({}, 'email.sent');
      return Promise.resolve();
    });
    expect(lines()[0]).not.toHaveProperty('trace_id');
  });
});

describe('hooks', () => {
  it('reads queue depth and age, pool connections, and Redis latency', async () => {
    const { t, exported } = telemetry();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    observeQueues(
      t.metrics,
      [
        {
          name: 'email.send',
          getJobCounts: () =>
            Promise.resolve({ waiting: 4, delayed: 1, prioritized: 0, paused: 0 }),
          getJobs: () => Promise.resolve([{ timestamp: now - 90_000 }]),
        },
        {
          name: 'notify.dispatch',
          getJobCounts: () => Promise.resolve({}),
          getJobs: () => Promise.resolve([]),
        },
      ],
      () => now,
    );
    observeDbPool(t.metrics, () => ({ max: 20, total: 12, idle: 4, waiting: 3 }));
    const redis = createMemoryRedis();
    const latency = sampleRedisLatency(t.metrics, () => redis.ping(), 60_000);
    await latency.sample();
    latency.stop();
    await t.flush();
    const got = exported();
    const value = (name: string, attributes: Record<string, unknown> = {}) =>
      got.find(
        (p) => p.name === name && JSON.stringify(p.attributes) === JSON.stringify(attributes),
      )?.value;
    expect(value('centcom_queue_depth', { queue: 'email.send' })).toBe(5);
    expect(value('centcom_queue_depth', { queue: 'notify.dispatch' })).toBe(0);
    expect(value('centcom_queue_oldest_age_seconds', { queue: 'email.send' })).toBe(90);
    expect(value('centcom_db_pool_connections', { state: 'in_use' })).toBe(8);
    expect(value('centcom_db_pool_connections', { state: 'waiting' })).toBe(3);
    expect(value('centcom_db_pool_max_connections')).toBe(20);
    expect(value('centcom_redis_ping_seconds')).toBe(1);
  });
});

/** A metric exporter that fails every export and keeps what it was given. */
class RefusingMetricExporter implements PushMetricExporter {
  readonly given: ResourceMetrics[] = [];
  export(metrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    this.given.push(metrics);
    done({ code: ExportResultCode.FAILED, error: new Error('collector unreachable') });
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** A TCP server that accepts connections and never answers (a hung collector). */
async function blackhole(): Promise<{ url: string; server: Server }> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

describe('when the collector is down', () => {
  it('drops telemetry, counts the failed exports, and keeps the service going', async () => {
    const refusing = new RefusingMetricExporter();
    const t = initTelemetry({
      service: 'api',
      version: '1',
      env: 'test',
      config: { ...ON, endpoint: 'http://127.0.0.1:9' },
      metricExporter: refusing,
      metricIntervalMs: 60_000,
      strict: true,
    });
    opened.push(t);
    t.metrics
      .counter('http_requests_total', { route: '/v1/me', method: 'GET', status_class: '2xx' })
      .inc();
    for (let i = 0; i < 50; i += 1) t.tracer.startSpan(`span ${i}`).end();
    await t.flush(); // metrics refused; spans to a closed port (refused)
    await t.flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await t.flush();
    const last = refusing.given.at(-1);
    const failed =
      last === undefined
        ? []
        : points(last).filter((p) => p.name === 'centcom_otel_export_failed_total');
    const bySignal = Object.fromEntries(failed.map((p) => [p.attributes['signal'], p.value]));
    expect(bySignal['metrics']).toBeGreaterThanOrEqual(2);
    expect(bySignal['traces']).toBeGreaterThanOrEqual(1);
  });

  it('records without waiting on the collector, and shuts down within 5 s', async () => {
    const hole = await blackhole();
    try {
      const t = initTelemetry({
        service: 'api',
        version: '1',
        env: 'test',
        config: { ...ON, endpoint: hole.url },
      });
      const started = performance.now();
      for (let i = 0; i < 5000; i += 1) {
        t.metrics
          .counter('http_requests_total', { route: '/v1/me', method: 'GET', status_class: '2xx' })
          .inc();
        t.tracer.startSpan('GET /v1/me').end();
      }
      // Recording never touches the network: 5 000 requests' worth takes well under a second.
      expect(performance.now() - started).toBeLessThan(1000);
      const stopping = performance.now();
      await t.shutdown();
      expect(performance.now() - stopping).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 500);
    } finally {
      hole.server.close();
    }
  }, 20_000);
});
