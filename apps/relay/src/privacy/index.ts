/**
 * Relay privacy (B050): the gate on the frame path, the log scrubber, the metric label guard and
 * their allowlists. The relay module is `module.ts` (order 30); `startRelay` applies the scrubber
 * and the guard to every module.
 */
export {
  CARD_LOG_FIELDS,
  LOG_FIELDS,
  METRIC_LABELS,
  NEVER_LOGGED,
  OPERATIONAL_LOG_FIELDS,
} from './allowlists.js';
export { createRelayLogger, MAX_DEPTH, scrubFields } from './logger.js';
export { assertMetricLabels, guardMetrics, MAX_LABEL_VALUE, MetricLabelError } from './metrics.js';
export {
  catalogued,
  clearBytes,
  MAX_CLEAR_BYTES,
  sanitizeClearPayload,
  SERVER_BUILT,
} from './sanitize.js';
export { PRIVACY_TOO_LARGE_DETAIL, privacyStage } from './stage.js';
