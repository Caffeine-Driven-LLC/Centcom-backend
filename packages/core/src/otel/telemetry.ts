/**
 * The telemetry bootstrap (B093): `initTelemetry({service, version, env})` gives a service its
 * OpenTelemetry meter and tracer, and the catalogue-checked `Metrics` (metrics.ts) its code records
 * through.
 *
 * - **Export:** OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (`/v1/metrics` every 15 s, `/v1/traces`
 *   in batches), each export timing out after 5 s. Spans wait in a queue of at most 2 048; when it
 *   is full, new spans are dropped. A failed export is dropped and counted
 *   (`otel_export_failed_total{signal}`); nothing is retried without bound and nothing waits on
 *   the collector, so a collector outage never slows a request.
 * - **Sampling:** OTEL_SAMPLE_RATIO of new traces (default 5 %), at the source; the collector then
 *   keeps every error and slow trace it receives and 5 % of the rest.
 * - **Privacy:** spans are redacted before export (exporters.ts, redact.ts); metric labels are held
 *   to the catalogue.
 * - **Off:** with OTEL_ENABLED=false, and always under tests, the meter and tracer are no-ops (the
 *   catalogue checks still run).
 * - **Shutdown:** `shutdown()` flushes what is buffered and resolves within 5 s, whatever the
 *   collector does.
 *
 * Owns: the providers and their settings. Must not: block on an exporter, or register globals
 * (each service holds its own providers).
 */
import { createNoopMeter, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type { Logger } from '../log/logger.js';
import type { ServiceName } from './catalogue.js';
import { loadOtelConfig, type OtelConfig } from './config.js';
import { SafeMetricExporter, SafeSpanExporter } from './exporters.js';
import { catalogueMetrics, type MetricViolation, type TelemetryMetrics } from './metrics.js';

/** Spans waiting for export, at most. */
export const SPAN_QUEUE_MAX = 2048;
/** Longest an export may take. */
export const EXPORT_TIMEOUT_MS = 5000;
/** How often metrics are exported. */
export const METRIC_EXPORT_INTERVAL_MS = 15_000;
/** `shutdown()` resolves within this (inside the card's 5 s, with room for the process to exit). */
export const SHUTDOWN_TIMEOUT_MS = 4500;

/** What a service starts telemetry with. */
export interface TelemetryOptions {
  service: ServiceName;
  version: string;
  /** Deployment environment (`dev`, `stage`, `prod`). */
  env: string;
  /** Region the instance runs in, for the dashboards' region variable. */
  region?: string;
  /** Default loadOtelConfig(). */
  config?: OtelConfig;
  /** Default OTLP/HTTP to the configured endpoint (tests pass in-memory exporters). */
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  /** Default METRIC_EXPORT_INTERVAL_MS. */
  metricIntervalMs?: number;
  /** Throw on catalogue violations instead of rewriting (tests, load runs). */
  strict?: boolean;
  /** Hears of catalogue violations (once per metric and kind) and export failures. */
  logger?: Logger;
}

/** A service's telemetry. */
export interface Telemetry {
  readonly enabled: boolean;
  readonly service: ServiceName;
  readonly meter: Meter;
  readonly tracer: Tracer;
  /** Where the service's code records metrics (core `Metrics` plus gauges). */
  readonly metrics: TelemetryMetrics;
  /** Exports what is buffered now. */
  flush(): Promise<void>;
  /** Flushes and stops; resolves within SHUTDOWN_TIMEOUT_MS. */
  shutdown(): Promise<void>;
}

/** Resolves when `work` settles or after `ms`, whichever is first; never rejects. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

/** Starts telemetry for a service (see the module comment). */
export function initTelemetry(opts: TelemetryOptions): Telemetry {
  const config = opts.config ?? loadOtelConfig();
  const reported = new Set<string>();
  const onViolation = (v: MetricViolation): void => {
    const key = `${v.kind}|${v.metric}`;
    if (reported.has(key)) return;
    reported.add(key);
    opts.logger?.warn(
      { metric: v.metric, kind: v.kind, ...(v.label === undefined ? {} : { label: v.label }) },
      'otel.metric_violation',
    );
  };
  const metricsOptions = {
    onViolation,
    ...(opts.strict === undefined ? {} : { strict: opts.strict }),
  };

  if (!config.enabled) {
    const meter = createNoopMeter();
    return {
      enabled: false,
      service: opts.service,
      meter,
      tracer: trace.getTracerProvider().getTracer(`centcom-${opts.service}`),
      metrics: catalogueMetrics(meter, metricsOptions),
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
  }

  const resource = resourceFromAttributes({
    'service.name': `centcom-${opts.service}`,
    'service.namespace': 'centcom',
    'service.version': opts.version,
    'deployment.environment.name': opts.env,
    ...(opts.region === undefined ? {} : { 'cloud.region': opts.region }),
  });

  // Export failures are counted through the meter itself; set once it exists.
  let countFailure: (signal: 'traces' | 'metrics') => void = () => undefined;
  const failed = (signal: 'traces' | 'metrics'): void => countFailure(signal);

  const metricExporter = new SafeMetricExporter(
    opts.metricExporter ??
      new OTLPMetricExporter({
        url: `${config.endpoint}/v1/metrics`,
        timeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    failed,
  );
  const interval = opts.metricIntervalMs ?? METRIC_EXPORT_INTERVAL_MS;
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: interval,
        // The SDK wants the timeout no longer than the interval.
        exportTimeoutMillis: Math.min(EXPORT_TIMEOUT_MS, interval),
      }),
    ],
  });
  const meter = meterProvider.getMeter(`centcom-${opts.service}`, opts.version);
  const metrics = catalogueMetrics(meter, metricsOptions);
  countFailure = (signal) => {
    try {
      metrics.counter('otel_export_failed_total', { signal }).inc();
    } catch {
      // A strict bridge never throws for this catalogued metric; nothing else may escape here.
    }
  };

  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanProcessors: [
      new BatchSpanProcessor(
        new SafeSpanExporter(
          opts.traceExporter ??
            new OTLPTraceExporter({
              url: `${config.endpoint}/v1/traces`,
              timeoutMillis: EXPORT_TIMEOUT_MS,
            }),
          failed,
        ),
        {
          maxQueueSize: SPAN_QUEUE_MAX,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 2000,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        },
      ),
    ],
  });
  const tracer = tracerProvider.getTracer(`centcom-${opts.service}`, opts.version);

  let stopped: Promise<void> | undefined;
  return {
    enabled: true,
    service: opts.service,
    meter,
    tracer,
    metrics,
    flush: () =>
      within(
        Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]),
        SHUTDOWN_TIMEOUT_MS,
      ),
    shutdown: () => {
      stopped ??= within(
        Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]),
        SHUTDOWN_TIMEOUT_MS,
      );
      return stopped;
    },
  };
}
