/**
 * Exporter guards (B093): every span is redacted before it leaves (redact.ts), and every export
 * that fails is counted in `otel_export_failed_total{signal}` and dropped: telemetry never holds a
 * request up and never retries without bound (the SDK's queues are bounded: 2 048 spans, exports
 * time out after 5 s).
 *
 * Owns: the wrappers. Must not: pass an unredacted span to an exporter.
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { redactAttributes } from './redact.js';

/** A copy of `span` with its attributes, events' and links' attributes redacted. */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const context = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => context,
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status.message === undefined ? span.status : { code: span.status.code },
    attributes: redactAttributes(span.attributes),
    links: span.links.map((link) => ({
      ...link,
      ...(link.attributes === undefined ? {} : { attributes: redactAttributes(link.attributes) }),
    })),
    events: span.events.map((event) => ({
      ...event,
      ...(event.attributes === undefined ? {} : { attributes: redactAttributes(event.attributes) }),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Called once per failed export, with the signal. */
export type ExportFailed = (signal: 'traces' | 'metrics') => void;

/** A span exporter that redacts and counts failures. */
export class SafeSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly failed: ExportFailed,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans.map(redactSpan), (result) => {
        if (result.code !== ExportResultCode.SUCCESS) this.failed('traces');
        done(result);
      });
    } catch (error) {
      this.failed('traces');
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** A metric exporter that counts failures. */
export class SafeMetricExporter implements PushMetricExporter {
  constructor(
    private readonly inner: PushMetricExporter,
    private readonly failed: ExportFailed,
  ) {
    if (inner.selectAggregationTemporality !== undefined) {
      this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
    }
    if (inner.selectAggregation !== undefined) {
      this.selectAggregation = inner.selectAggregation.bind(inner);
    }
  }

  selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  selectAggregation?: PushMetricExporter['selectAggregation'];

  export(metrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    try {
      this.inner.export(metrics, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) this.failed('metrics');
        done(result);
      });
    } catch (error) {
      this.failed('metrics');
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
