/**
 * Instrumentation hooks (B093) for what the services run on, typed by shape so core needs none of
 * the libraries:
 *
 * - `traceJob(telemetry, queue, run)`: one job execution (BullMQ processors): a span, the job's
 *   duration (`job_duration_seconds{queue}`) and failures (`job_failed_total{queue}`), and the
 *   span's trace id in the log lines written while it runs;
 * - `observeQueues(metrics, queues)`: `queue_depth{queue}` (waiting, delayed, prioritized, paused)
 *   and `queue_oldest_age_seconds{queue}`, read at each export;
 * - `observeDbPool(metrics, stats)`: `db_pool_connections{state}` and `db_pool_max_connections`
 *   (B007's poolStats);
 * - `sampleRedisLatency(metrics, ping)`: `redis_ping_seconds`, a PING every 15 s.
 *
 * HTTP requests are traced by the API's telemetry plugin and relay connections by the relay; both
 * follow the same rules: names and attributes from fixed sets, ids only as request ids.
 *
 * Owns: the hooks. Must not: attach an id other than a request id, or job data, to a span or label.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { SpanKind, SpanStatusCode, TraceFlags, type Span, type Tracer } from '@opentelemetry/api';
import { getRequestContext, runWithContext } from '../log/context.js';
import type { TelemetryMetrics } from './metrics.js';

/** Upper bounds, in seconds, of `job_duration_seconds`. */
export const JOB_DURATION_BUCKETS_S: readonly number[] = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
]);
/** Upper bounds, in seconds, of `redis_ping_seconds`. */
export const REDIS_PING_BUCKETS_S: readonly number[] = Object.freeze([
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1,
]);
/** How often Redis is pinged for latency. */
export const REDIS_PING_INTERVAL_MS = 15_000;

/** The trace id of `span` when it is sampled (only those reach the trace store). */
export function sampledTraceId(span: Span): string | undefined {
  const context = span.spanContext();
  return (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
    ? context.traceId
    : undefined;
}

/** What `traceJob` needs. */
export interface JobTelemetry {
  tracer: Tracer;
  metrics: Pick<TelemetryMetrics, 'counter' | 'histogram'>;
}

/** Runs one job execution of `queue` traced and measured (see the module comment). */
export async function traceJob<T>(
  telemetry: JobTelemetry,
  queue: string,
  run: () => Promise<T>,
): Promise<T> {
  const span = telemetry.tracer.startSpan(`job ${queue}`, {
    kind: SpanKind.CONSUMER,
    attributes: { 'messaging.system': 'bullmq', 'messaging.destination.name': queue },
  });
  const traceId = sampledTraceId(span);
  const outer = getRequestContext();
  const context = {
    ...(outer ?? { requestId: newId('req') }),
    ...(traceId === undefined ? {} : { traceId }),
  };
  const started = performance.now();
  try {
    const result = await runWithContext(context, run);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    telemetry.metrics.counter('job_failed_total', { queue }).inc();
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', error instanceof Error ? error.name : typeof error);
    throw error;
  } finally {
    telemetry.metrics
      .histogram('job_duration_seconds', JOB_DURATION_BUCKETS_S)
      .observe((performance.now() - started) / 1000, { queue });
    span.end();
  }
}

/** A queue, by the BullMQ methods the gauges read. */
export interface QueueLike {
  readonly name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobs(
    types: string[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<({ timestamp: number } | undefined)[]>;
}

/** Registers the queue gauges for `queues`; `now` in milliseconds (default Date.now). */
export function observeQueues(
  metrics: Pick<TelemetryMetrics, 'gauge'>,
  queues: readonly QueueLike[],
  now: () => number = Date.now,
): void {
  metrics.gauge('queue_depth', async () =>
    Promise.all(
      queues.map(async (q) => {
        const counts = await q.getJobCounts('waiting', 'delayed', 'prioritized', 'paused');
        const depth = Object.values(counts).reduce(
          (sum, n) => sum + (Number.isFinite(n) ? n : 0),
          0,
        );
        return { value: depth, labels: { queue: q.name } };
      }),
    ),
  );
  metrics.gauge('queue_oldest_age_seconds', async () =>
    Promise.all(
      queues.map(async (q) => {
        const [oldest] = await q.getJobs(['waiting'], 0, 0, true);
        const age = oldest === undefined ? 0 : Math.max(0, (now() - oldest.timestamp) / 1000);
        return { value: age, labels: { queue: q.name } };
      }),
    ),
  );
}

/** A connection pool's numbers (B007's PoolStats). */
export interface PoolNumbers {
  max: number;
  total: number;
  idle: number;
  waiting: number;
}

/** Registers the pool gauges, read from `stats` at each export. */
export function observeDbPool(
  metrics: Pick<TelemetryMetrics, 'gauge'>,
  stats: () => PoolNumbers | undefined,
): void {
  metrics.gauge('db_pool_connections', () => {
    const s = stats();
    if (s === undefined) return [];
    return [
      { value: s.total, labels: { state: 'total' } },
      { value: s.idle, labels: { state: 'idle' } },
      { value: s.total - s.idle, labels: { state: 'in_use' } },
      { value: s.waiting, labels: { state: 'waiting' } },
    ];
  });
  metrics.gauge('db_pool_max_connections', () => stats()?.max ?? 0);
}

/** Pings Redis every `intervalMs` and records the round trip; `stop()` ends it. */
export function sampleRedisLatency(
  metrics: Pick<TelemetryMetrics, 'histogram'>,
  ping: () => Promise<void>,
  intervalMs: number = REDIS_PING_INTERVAL_MS,
): { sample(): Promise<void>; stop(): void } {
  const histogram = metrics.histogram('redis_ping_seconds', REDIS_PING_BUCKETS_S);
  const sample = async (): Promise<void> => {
    const started = performance.now();
    try {
      await ping();
    } catch {
      return; // an unreachable Redis is counted by the backend (redis_unavailable_total)
    }
    histogram.observe((performance.now() - started) / 1000);
  };
  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  return { sample, stop: () => clearInterval(timer) };
}
