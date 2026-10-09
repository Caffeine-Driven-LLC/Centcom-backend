/**
 * Key grants and epochs (B049, CT-CRYPTO §4-5): `key.grant` routing checks, `ct.kid` enforcement,
 * and `control.rotate_key` signalling. The relay module is `module.ts` (order 25, plus a stage at
 * 41).
 */
export {
  createMemorySessionDevices,
  createPostgresSessionDevices,
  DEVICE_CACHE_MS,
  type SessionDevices,
} from './devices.js';
export {
  createMemoryEpochStore,
  createRedisEpochStore,
  EPOCH_ANNOUNCE_LUA,
  epochKey,
  type EpochState,
  type EpochStore,
} from './epoch-store.js';
export {
  CACHE_MS,
  createEpochs,
  epochOf,
  ROTATE_REASONS,
  SCHEDULE_AGE_MS,
  SCHEDULE_FRAMES,
  type EpochSignal,
  type EpochTracker,
  type EpochsDeps,
  type KidCheck,
  type RotateReason,
} from './epochs.js';
export { createKeysModule } from './module.js';
export { KEYS_DETAILS, keysStage, rotateStage } from './stage.js';
export { MAX_GRANT_KIDS, validateKeyGrant, type GrantCheck } from './validate.js';
