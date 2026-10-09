/**
 * @centcom/storage: object storage and the durable session history log, shared by the API (B055's
 * REST history, B082's audit exports) and the relay (B042's durable append, replay and hydration).
 *
 * - `object-store.ts`: the `OBJECT_STORE_*` settings.
 * - `sigv4.ts`: AWS Signature Version 4 (B082).
 * - `blob-store.ts`, `s3-blob-store.ts`, `memory-blob-store.ts`: the blob port, its S3/R2 and
 *   in-memory stores, keys and the batch format (B055).
 * - `store.ts`, `writer.ts`, `ports.ts`: the history store, its writer and types (B055).
 */
export {
  BATCH_CONTENT_TYPE,
  BlobNotFoundError,
  BlobStoreError,
  decodeBatch,
  encodeBatch,
  frameSize,
  historyBlobKey,
  historyPrefix,
  parseBlobKey,
  type BlobStore,
} from './blob-store.js';
export { createMemoryBlobStore, type MemoryBlobStore } from './memory-blob-store.js';
export {
  loadObjectStoreConfig,
  objectStoreConfigOf,
  objectStoreEnvSchema,
  objectStoreEnvShape,
  type ObjectStoreConfig,
} from './object-store.js';
export type {
  CtObject,
  HistoryAccess,
  HistoryRead,
  HistoryStore,
  KindClass,
  SessionStanding,
  StoredFrame,
} from './ports.js';
export { BLOB_IDLE_TIMEOUT_MS, createS3BlobStore, type S3BlobStoreDeps } from './s3-blob-store.js';
export {
  amzDate,
  authorizationHeader,
  canonicalPath,
  canonicalQuery,
  EMPTY_SHA256,
  encodeRfc3986,
  presignQuery,
  SIGV4_ALGORITHM,
  UNSIGNED_PAYLOAD,
  type SignableRequest,
  type SigningCredentials,
} from './sigv4.js';
export {
  createHistoryStore,
  createWorkspaceHistoryPurger,
  retentionExpiry,
  toStoredFrame,
  type HistoryStoreDeps,
  type RejectReason,
  type SequencedFrame,
} from './store.js';
export {
  APPEND_ATTEMPTS,
  APPEND_BACKOFF_BASE_MS,
  BATCH_MAX_DELAY_MS,
  BATCH_MAX_FRAMES,
  HistoryFrameRefused,
  HistoryWriter,
  type HistoryWriterDeps,
  type WriterTimer,
} from './writer.js';
