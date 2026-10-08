/**
 * Feature flags and remote config (B083, CT-API-FLAGS). Server code imports `FlagService.isEnabled`
 * (or the pure `evaluateFlags` / `isEnabledIn`); B087's admin tooling calls `FlagAdmin`. See
 * README.md.
 */
export {
  FLAG_AUDIT_ACTIONS,
  FLAG_DELETE_ACTION,
  FLAG_SET_ACTION,
  type FlagAuditAction,
} from './actions.js';
export { BUCKETS, bucketOf, inRollout } from './bucket.js';
export {
  FLAGS_CHANNEL,
  FLAGS_POLL_MS,
  FLAGS_RETRY_AFTER_S,
  FLAGS_STALE_MS,
  FlagCache,
  parseFlagsMessage,
  type FlagCacheDeps,
  type FlagSnapshot,
} from './cache.js';
export { flagsEnvSchema, loadFlagsConfig, type FlagsConfig } from './config.js';
export {
  checkFlagDef,
  FLAG_KEY,
  PLANS,
  readStoredFlag,
  type EvalFlag,
  type FlagDef,
  type FlagRule,
  type FlagType,
  type FlagValue,
  type Plan,
  type StoredFlagDef,
} from './definition.js';
export { evaluateFlags, isEnabledIn, type EvalContext, type FlagSet } from './evaluate.js';
export {
  createFlagRepository,
  FlagLimitError,
  type FlagRepository,
  type StoredRow,
} from './repository.js';
export {
  ANONYMOUS_TTL_S,
  definitionHash,
  FlagAdmin,
  flagsEtag,
  FlagService,
  MAX_FLAGS_BODY_BYTES,
  type FlagAdminDeps,
  type FlagsAnswer,
  type FlagsBody,
  type FlagServiceDeps,
} from './service.js';
export { compareSemver, parseClientVersion, parseSemver, type Semver } from './version.js';
