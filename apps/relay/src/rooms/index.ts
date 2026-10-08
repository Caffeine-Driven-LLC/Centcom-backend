/**
 * Session rooms and membership authorisation (B043): the registry, the kind policy, live
 * membership, the Postgres SessionAccess and the room side of the handshake. The relay module is
 * `module.ts` (order 20).
 */
export {
  createPostgresSessionAccess,
  effectivePlan,
  loadSessionEntitlements,
  roomHasSpace,
  sessionFull,
  type AccessDb,
  type AccessDbClient,
  type PostgresSessionAccessDeps,
  type SessionEntitlements,
  type SubscriptionState,
} from './access.js';
export {
  createRooms,
  parseMembershipEvent,
  RESUBSCRIBE_BASE_MS,
  RESUBSCRIBE_MAX_MS,
  ROOM_DETAILS,
  type RoomsDeps,
} from './authorise.js';
export {
  authorizeFrame,
  KIND_MIN_ROLE,
  MEMBER_FRAME_TYPES,
  memoryMuteState,
  noMutes,
  SERVER_ONLY_KINDS,
  UNKNOWN_KIND_ROLES,
  type FrameDecision,
  type FrameKind,
  type MemberRole,
  type MuteState,
  type SessionRole,
} from './kind-policy.js';
export {
  capRole,
  createPostgresMembership,
  LiveMembership,
  MEMBERSHIP_CACHE_MAX_ENTRIES,
  MEMBERSHIP_CACHE_TTL_MS,
  type LiveMember,
  type LiveMembershipOptions,
  type MembershipSource,
} from './membership.js';
export {
  createRoomRegistry,
  ROOM_EVICT_AFTER_MS,
  type MemberView,
  type Room,
  type RoomRegistry,
  type RoomRegistryOptions,
  type RoomTimer,
} from './registry.js';
export { roomsFor, type RoomsRuntime } from './runtime.js';
