/**
 * Presence (B047, CT-WS-PRESENCE): ephemeral, coalesced presence per member, the snapshot after a
 * welcome, and online/offline from the connection. The relay module is `module.ts` (order 35).
 */
export {
  DEFAULT_OFFLINE_GRACE_MS,
  DEFAULT_PRESENCE_IN_MS,
  DEFAULT_PRESENCE_OUT_MS,
  loadPresenceConfig,
  presenceEnvSchema,
} from './config.js';
export { createPresenceModule } from './module.js';
export {
  createPresence,
  MAX_MEMBERS,
  presenceFrame,
  type PresenceConfig,
  type PresenceDeps,
  type PresenceTimer,
} from './service.js';
export { PRESENCE_INVALID_DETAIL, presenceStage } from './stage.js';
export {
  createMemoryPresenceStore,
  createRedisPresenceStore,
  PRESENCE_TTL_MS,
  presenceKey,
  withFallback,
  type PresenceStore,
} from './store.js';
export {
  PRESENCE_UPDATE,
  type PresenceEntry,
  type PresenceService,
  type PresenceUpdate,
} from './types.js';
export { checkPresenceUpdate, MAX_AGENT_COUNT } from './validate.js';
