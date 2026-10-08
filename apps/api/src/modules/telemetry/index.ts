/**
 * Opt-in telemetry (B085, CT-TELEMETRY): ingest (`TelemetryIngest`, route `routes/telemetry.ts`),
 * the allow-list (`scrubBatch`), per-address and per-install limits, storage in day partitions,
 * and retention (`TelemetryRetention`, run by the worker's `telemetry-retention` queue).
 */
export {
  loadTelemetryConfig,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  TELEMETRY_RETENTION_DAYS,
  telemetryEnvSchema,
  type TelemetryConfig,
} from './config.js';
export {
  addressKey,
  INSTALL_BATCHES_PER_MINUTE,
  IP_BATCHES_PER_MINUTE,
  TelemetryLimits,
} from './limits.js';
export {
  createTelemetryRepository,
  dayOf,
  INSERT_TIMEOUT_MS,
  type TelemetryRepository,
} from './repository.js';
export { TelemetryRetention, type TelemetryRetentionDeps } from './retention.js';
export {
  EVENT_TYPES,
  INSTALL_ID,
  looksLikePii,
  scrubBatch,
  type DropReason,
  type EventType,
  type PropValue,
  type ScrubResult,
  type StoredEvent,
} from './scrub.js';
export {
  TelemetryIngest,
  type IngestOutcome,
  type TelemetryIngestDeps,
  type TelemetryRequest,
} from './service.js';
