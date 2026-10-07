/**
 * Idempotency (B024, CT-PAGE): request fingerprints, the records kept under an Idempotency-Key
 * (in-flight lock, then the response for 24 h) and the encryption of sensitive responses. The
 * Fastify plugin that applies it lives in `apps/api/src/plugins/idempotency.ts`. See README.md in
 * this package.
 */
export {
  ENCRYPTION_KEY_BYTES,
  idempotencyConfig,
  idempotencyEnvSchema,
  openBody,
  sealBody,
  type IdempotencyConfig,
  type SealedBody,
} from './crypto.js';
export {
  canonicalJson,
  FINGERPRINT_PREFIX,
  fingerprintRequest,
  fingerprintsEqual,
} from './fingerprint.js';
export {
  createIdempotencyStore,
  DEFAULT_MAX_STORED_BYTES,
  IDEMPOTENCY_DETAILS,
  IDEMPOTENCY_KEY_POINTER,
  IN_FLIGHT_WAIT_MS,
  LOCK_TTL_MS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_STORED_BYTES,
  parseIdempotencyKey,
  RECORD_TTL_MS,
  STORED_HEADERS,
  storeKeyFor,
  type Claim,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
  type NotStoredReason,
  type StoredResponse,
} from './store.js';
