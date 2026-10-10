/**
 * Session control (B051, CT-WS-CONTROL): the host's kick, mute, unmute, role, transfer_host, end
 * and policy frames, enforced by the relay. The relay module is `module.ts` (order 38).
 */
export {
  checkAuthority,
  CLIENT_CONTROL_KINDS,
  CONTROL_DETAILS,
  isClientControlKind,
  targetOf,
  type Authorised,
  type AuthorityDeps,
  type ControlKind,
  type Refusal,
} from './authority.js';
export {
  connectedKey,
  CONNECTED_REFRESH_MS,
  CONNECTED_TTL_MS,
  createConnections,
  type ConnectionsDeps,
} from './connections.js';
export {
  controlMeta,
  controlTarget,
  createControlHandler,
  ENDED_SESSIONS_MAX,
  RECENT_FRAMES_MAX,
  sendControlError,
  type ControlContext,
  type ControlDeps,
  type ControlFrameIn,
  type ControlHandler,
  type ControlOutcome,
  type ControlSender,
} from './handler.js';
export {
  createMemoryMuteStore,
  createMuteRegistry,
  createPostgresMuteStore,
  MUTE_CACHE_MAX_SESSIONS,
  MUTE_CACHE_TTL_MS,
  type Mute,
  type MuteRegistry,
  type MuteRegistryDeps,
  type MuteStore,
} from './mute-registry.js';
export {
  createMemoryPolicyStore,
  createPostgresPolicyStore,
  DEFAULT_POLICY,
  isPolicyError,
  MAX_POLICY_MEMBERS,
  MAX_QUEUE_LIMIT,
  policyFrom,
  type ControlDb,
  type PolicyError,
  type PolicyStore,
  type SessionPolicy,
  type StoredPolicy,
} from './policy-store.js';
export type {
  ConnectionRegistryPort,
  MembershipPort,
  SequencerPort,
  ServerFrame,
  SessionState,
  SessionStatePort,
} from './ports.js';
export { createPostgresMembershipPort, createPostgresSessionState } from './postgres.js';
export { controlStage } from './stage.js';
