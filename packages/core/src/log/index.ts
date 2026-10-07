/**
 * Logging (B005): structured JSON logs with request ids and redaction, the request context that
 * carries the ids, and the metrics interface. Services create one logger at the entrypoint with
 * `createLogger` and pass it on; there is no unredacted logger to reach for.
 */
export {
  createLogger,
  MAX_LOG_BUFFER_BYTES,
  type LogFields,
  type LogFn,
  type Logger,
  type LoggerOptions,
} from './logger.js';
export {
  MAX_LOG_DEPTH,
  MAX_LOG_ENTRIES,
  MAX_LOG_STRING_LENGTH,
  redact,
  TRUNCATED,
  UNSERIALISABLE,
} from './redact.js';
export { getRequestContext, runWithContext, type RequestContext } from './context.js';
export {
  noopMetrics,
  type Counter,
  type Histogram,
  type MetricLabels,
  type Metrics,
} from './metrics.js';
