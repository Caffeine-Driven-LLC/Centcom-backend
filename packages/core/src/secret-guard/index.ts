/**
 * The credential-leak guard (B101). Import as a namespace: `import { secretGuard } from '@centcom/core'`.
 * See README.md for the surfaces and how to mount them.
 */
export {
  ALLOW_SCOPES,
  AllowListError,
  MAX_ALLOW_ENTRIES,
  EMPTY_ALLOW_LIST,
  createAllowList,
  loadAllowListFile,
} from './allow.js';
export type { AllowEntry, AllowList, AllowScope, Location } from './allow.js';
export { loadPatterns, compilePatterns } from './patterns.js';
export type { Hit, Pattern } from './patterns.js';
export {
  scanText,
  scanJson,
  walkStrings,
  ScanLimitError,
  SCAN_BUDGET_MS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
} from './scan.js';
export type { ScanOptions } from './scan.js';
export {
  redactText,
  redactJson,
  redactTextCollect,
  redactJsonCollect,
  markerFor,
  isMarker,
} from './redact.js';
export { createGuardedLogger, UNSCANNABLE } from './logger.js';
export { secretGuardHook, REJECTION_DETAIL, DEFAULT_MAX_BODY_BYTES } from './fastify.js';
export type {
  SecretGuardHook,
  SecretGuardHookOptions,
  GuardRequest,
  GuardReply,
} from './fastify.js';
export { guardFrame, stripCiphertext, UNSCANNABLE_PATTERN } from './frame.js';
export type { FrameVerdict, GuardFrameOptions } from './frame.js';
export { guardTelemetryBatch } from './telemetry.js';
export {
  scanBackupStream,
  backupScanHook,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_OVERLAP_BYTES,
} from './backup.js';
export type { BackupScan, BackupVerdict, BackupScanContext } from './backup.js';
export { guardMetrics, SCAN_SECONDS_BUCKETS } from './metrics.js';
export type { GuardMetrics, Surface } from './metrics.js';
export { secretGuardConfig, secretGuardEnvSchema } from './config.js';
export type { SecretGuardConfig } from './config.js';
