/**
 * Cross-node routing (B045): frames, ephemeral frames and member commands between relay nodes over
 * Redis pub/sub, in `seq` order for every client. The relay module is `module.ts` (order 60).
 */
export {
  checkCommand,
  controlChannel,
  ephemeralChannel,
  framesChannel,
  nodeKey,
  parseControlMessage,
  parseEphemeralMessage,
  parseFrameMessage,
  type ControlMessage,
  type FrameMessage,
  type MemberCommand,
} from './channels.js';
export {
  clusterEnvSchema,
  DEFAULT_CLUSTER_GAP_MS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_UNSUB_GRACE_MS,
  loadClusterConfig,
  type ClusterConfig,
} from './config.js';
export { ClusterDispatcher, LAG_BUCKETS_S, type ClusterDispatcherDeps } from './dispatcher.js';
export { CLUSTER_ORDER, createClusterModule } from './module.js';
export {
  createClusterNode,
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_TTL_MS,
  SUBSCRIBE_RETRY_BASE_MS,
  SUBSCRIBE_RETRY_MAX_MS,
  type ClusterNode,
  type ClusterNodeDeps,
  type ClusterTimer,
  type MemberControl,
} from './node.js';
