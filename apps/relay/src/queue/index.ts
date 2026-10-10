/**
 * The command-post queue (B052, CT-WS-QUEUE): ordering, dedupe, approval, reorder, caps and the
 * auto-approve policy, with the authoritative `queue.state`. The relay module is `module.ts`
 * (order 39).
 */
export { autoApproval, autoApproveId, type AutoApproval } from './policy-approver.js';
export type {
  PersistedQueue,
  PolicyReader,
  QueuePolicy,
  QueueSequencer,
  QueueStore,
  QueueTx,
} from './ports.js';
export {
  createQueueService,
  MAX_ITEM_BYTES,
  MAX_LIVE_PER_MEMBER,
  QUEUE_CACHE_MAX_SESSIONS,
  QUEUE_SERVICE_DETAILS,
  RECENT_QUEUE_FRAMES_MAX,
  type QueueContext,
  type QueueFrameIn,
  type QueueOutcome,
  type QueueSender,
  type QueueService,
  type QueueServiceDeps,
  type Sequenced,
} from './service.js';
export { queueStage } from './stage.js';
export {
  cloneQueue,
  emptyQueue,
  LIVE_STATES,
  opOf,
  QUEUE_DETAILS,
  reduce,
  replay,
  view,
  type QueueItem,
  type QueueItemView,
  type QueueModel,
  type QueueOp,
  type QueueRefusal,
  type QueueState,
  type QueueStateBody,
  type Reduced,
  type ReplayFrame,
} from './state-machine.js';
export { createMemoryQueueStore, createPostgresQueueStore, type QueueDb } from './store.js';
