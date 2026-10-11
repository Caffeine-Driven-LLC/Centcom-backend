/**
 * Advisory file locks (B059, CT-WS-SESSION-EVENTS `file.lock`): acquire, release and expiry on
 * `path_hmac`, TTLs, FIFO waiters and caps. The relay module is `module.ts` (order 39).
 */
export {
  clampTtl,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
  MAX_LOCKS_PER_AGENT,
  MAX_LOCKS_PER_SESSION,
  MAX_WAITERS,
  PATH_HMAC,
  type ConflictHintPort,
  type DenyReason,
  type FileLockFrameIn,
  type HeldLock,
  type LockContext,
  type LockEmitter,
  type LockOutcome,
  type LockSender,
  type LockStore,
  type LockTx,
  type SessionLocks,
  type Waiter,
} from './ports.js';
export {
  LOCK_DETAILS,
  LockService,
  RECENT_LOCK_FRAMES_MAX,
  type LockServiceDeps,
} from './service.js';
export { lockStage } from './stage.js';
export { createRedisLockStore, lockKey, LOCK_DOC_TTL_MS } from './store.js';
export { dropWaiters, enqueue, next } from './waiters.js';
