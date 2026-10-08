/**
 * The API's telemetry (B093): the request context plugin recording through the catalogue bridge
 * and the request tracing plugin, with in-memory exporters.
 *
 * - every request is one span named by its route template, with the method, route, status and
 *   request id only (no URL, query or ids), an error status for a 5xx, and incoming `traceparent`
 *   ignored;
 * - the span's trace id appears in the log lines of the same request (and only for sampled spans);
 * - after traffic, the API's own catalogue metrics are exported (`centcom_http_requests_total`,
 *   `centcom_http_request_duration_seconds` with the 300 ms bucket the latency SLO reads), and no
 *   metric outside the catalogue.
 */
import {
  AppError,
  initTelemetry,
  METRIC_PREFIX,
  metricDef,
  METRICS,
  type MetricDef,
  type Telemetry,
} from '@centcom/core';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { telemetryPlugin } from '../../src/plugins/telemetry.js';
import { captureLogger } from '../helpers.js';

const opened: { app: FastifyInstance; telemetry: Telemetry }[] = [];
afterEach(async () => {
  for (const { app, telemetry } of opened.splice(0)) {
    await app.close();
    await telemetry.shutdown();
  }
});

async function api(sampleRatio = 1) {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({
    service: 'api',
    version: '1.0.0',
    env: 'test',
    config: { enabled: true, endpoint: 'http://127.0.0.1:9', sampleRatio },
    traceExporter: spans,
    metricExporter: metrics,
    metricIntervalMs: 60_000,
    strict: true,
  });
  const captured = captureLogger();
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger, metrics: telemetry.metrics });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(telemetryPlugin, { tracer: telemetry.tracer });
  app.get('/v1/things/:id', async (request) => {
    captured.logger.info({ thing: 'looked up' }, 'things.read');
    return { id: (request.params as { id: string }).id };
  });
  app.get('/v1/boom', async () => {
    throw new AppError('internal_error', { detail: 'it broke' });
  });
  await app.ready();
  opened.push({ app, telemetry });
  return { app, telemetry, spans, metrics, captured };
}

describe('request spans', () => {
  it('trace each request by its route template, with the trace id in its log lines', async () => {
    const { app, telemetry, spans, captured } = await api();
    const ids = ['usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'x'];
    const responses = [];
    for (const id of ids) {
      responses.push(
        await app.inject({
          method: 'GET',
          url: `/v1/things/${id}?email=alice@example.com`,
          headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
        }),
      );
    }
    const boom = await app.inject({ method: 'GET', url: '/v1/boom' });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/nowhere/usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    });
    await telemetry.flush();
    const finished = spans.getFinishedSpans();
    expect(finished.map((s) => s.name)).toEqual([
      'GET /v1/things/:id',
      'GET /v1/things/:id',
      'GET /v1/things/:id',
      'GET /v1/boom',
      'GET (unmatched)',
    ]);
    for (const [i, res] of [...responses, boom, missing].entries()) {
      const span = finished[i];
      expect(span?.attributes['centcom.request_id']).toBe(res.headers['x-request-id']);
      expect(span?.attributes['http.response.status_code']).toBe(res.statusCode);
      expect(span?.spanContext().traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(span?.parentSpanContext).toBeUndefined();
    }
    expect(finished[3]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(finished[3]?.attributes['error.type']).toBe('internal_error');
    expect(finished[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(finished.map((s) => s.attributes))).not.toMatch(
      /usr_|wsp_|alice|email|\?/,
    );

    // The log lines of a request carry its span's trace id.
    const reads = captured.lines().filter((l) => l['msg'] === 'things.read');
    expect(reads).toHaveLength(3);
    for (const [i, line] of reads.entries()) {
      expect(line['request_id']).toBe(responses[i]?.headers['x-request-id']);
      expect(line['trace_id']).toBe(finished[i]?.spanContext().traceId);
    }
  });

  it('leaves trace ids out of the logs of unsampled requests', async () => {
    const { app, captured } = await api(0);
    await app.inject({ method: 'GET', url: '/v1/things/a' });
    const read = captured.lines().find((l) => l['msg'] === 'things.read');
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('trace_id');
  });
});

describe('API metrics', () => {
  it('exports the API catalogue metrics after traffic, and nothing outside the catalogue', async () => {
    const { app, telemetry, metrics } = await api();
    for (let i = 0; i < 20; i += 1) {
      await app.inject({
        method: 'GET',
        url: `/v1/things/usr_01JA3Z8K2M5N7P9Q0R1S2T${String(i).padStart(4, '0')}`,
      });
    }
    await app.inject({ method: 'GET', url: '/v1/boom' });
    await telemetry.flush();
    const exported = metrics
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((s) => s.metrics));
    const names = new Set(exported.map((m) => m.descriptor.name));
    const owned = (Object.entries(METRICS) as [string, MetricDef][])
      .filter(
        ([, def]) =>
          def.group === 'platform' && def.services.length === 1 && def.services[0] === 'api',
      )
      .filter(([, def]) => def.planned === undefined && def.onFailure === undefined)
      .map(([name]) => `${METRIC_PREFIX}${name}`);
    expect(owned.sort()).toEqual([
      'centcom_http_request_duration_seconds',
      'centcom_http_requests_total',
    ]);
    for (const name of owned) expect(names.has(name), name).toBe(true);
    for (const name of names) {
      expect(name.startsWith(METRIC_PREFIX), name).toBe(true);
      expect(metricDef(name.slice(METRIC_PREFIX.length)), name).toBeDefined();
    }
    const requests = exported.find((m) => m.descriptor.name === 'centcom_http_requests_total');
    const labels = requests?.dataPoints.map((d) => d.attributes) ?? [];
    expect(labels).toEqual(
      expect.arrayContaining([
        { method: 'GET', route: '/v1/things/:id', status_class: '2xx' },
        { method: 'GET', route: '/v1/boom', status_class: '5xx' },
      ]),
    );
    const duration = exported.find(
      (m) => m.descriptor.name === 'centcom_http_request_duration_seconds',
    );
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);
    const bounds = (duration?.dataPoints[0]?.value as { buckets: { boundaries: number[] } }).buckets
      .boundaries;
    expect(bounds).toContain(0.3);
  });
});
