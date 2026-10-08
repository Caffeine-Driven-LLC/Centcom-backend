/**
 * Observability (B093): the metric catalogue, the catalogue-checked metrics bridge, the telemetry
 * bootstrap (`initTelemetry`), redaction rules, exporter guards and instrumentation hooks. See
 * docs/ops/observability.md.
 */
export {
  exportedName,
  FORBIDDEN_LABEL,
  MAX_LABEL_VALUES,
  METRIC_PREFIX,
  metricDef,
  METRICS,
  type MetricDef,
  type MetricName,
  type MetricType,
  type ServiceName,
} from './catalogue.js';
export { loadOtelConfig, otelEnvSchema, type OtelConfig } from './config.js';
export {
  redactSpan,
  SafeMetricExporter,
  SafeSpanExporter,
  type ExportFailed,
} from './exporters.js';
export {
  JOB_DURATION_BUCKETS_S,
  observeDbPool,
  observeQueues,
  REDIS_PING_BUCKETS_S,
  REDIS_PING_INTERVAL_MS,
  sampledTraceId,
  sampleRedisLatency,
  traceJob,
  type JobTelemetry,
  type PoolNumbers,
  type QueueLike,
} from './hooks.js';
export {
  catalogueMetrics,
  MetricViolationError,
  type CatalogueMetricsOptions,
  type GaugeValue,
  type MetricViolation,
  type TelemetryMetrics,
  type ViolationKind,
} from './metrics.js';
export {
  isDroppedAttribute,
  isUnsafeLabelValue,
  redactAttributes,
  redactTelemetryText,
} from './redact.js';
export {
  EXPORT_TIMEOUT_MS,
  initTelemetry,
  METRIC_EXPORT_INTERVAL_MS,
  SHUTDOWN_TIMEOUT_MS,
  SPAN_QUEUE_MAX,
  type Telemetry,
  type TelemetryOptions,
} from './telemetry.js';
