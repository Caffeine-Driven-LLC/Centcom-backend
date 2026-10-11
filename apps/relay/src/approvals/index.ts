/**
 * Approval routing (B060): `approval.request` / `approval.decision` between the right approvers,
 * with delegation, expiry and cleanup. See README.md.
 */
export { EXPIRY_CLAIM, sweepSession, type ExpiryDeps, type SessionSweep } from './expiry.js';
export { APPROVAL_SWEEP_MS } from './module.js';
export * from './ports.js';
export {
  approvalNeededEvent,
  dispatcherNotify,
  type DispatcherNotifyDeps,
  type NotificationPublisher,
  type SessionDecider,
} from './notify.js';
export { createPostgresDeciders } from './postgres.js';
export { ApprovalRouter, mayDecide, type ApprovalRouterDeps } from './router.js';
export { approvalStage } from './stage.js';
export {
  APPROVAL_LIST_TTL_MS,
  APPROVAL_MUTEX_TTL_MS,
  APPROVAL_MUTEX_WAIT_MS,
  approvalKey,
  createRedisApprovalStore,
} from './store.js';
