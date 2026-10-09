/**
 * Fan-out (B044): ordered, opaque delivery of sequenced frames to a session's room, and the
 * server's own sequenced frames. The relay module is `module.ts` (order 50).
 */
export {
  connectionSender,
  createFanOut,
  LATENCY_BUCKETS_S,
  MAX_HELD_FRAMES,
  noRemoteDispatcher,
  RESYNC_REASON,
  type ConnectionSender,
  type FanOut,
  type FanOutDeps,
  type HeldFrame,
  type LiveHold,
  type RemoteDispatcher,
} from './fanout.js';
export {
  createOrderedRelease,
  RELEASE_GAP_AFTER_MS,
  RELEASE_IDLE_MS,
  RELEASE_MAX_BUFFERED,
  type OrderedRelease,
  type OrderedReleaseOptions,
  type ReleaseTimer,
} from './release.js';
