/**
 * @centcom/worker: BullMQ jobs: webhooks, notifications, billing, retention. Today: the email
 * delivery job (B032), the workspace purge (B027), invite expiry (B029) and the projects purge hook
 * (B035). Later lanes add theirs under `src/jobs/`.
 */
export {
  createEmailQueue,
  DEFAULT_TIMEOUT_MS,
  DELIVERED_TTL_MS,
  EMAIL_BACKOFF_BASE_MS,
  EMAIL_BACKOFF_MAX_MS,
  emailBackoff,
  onEmailJobFailed,
  processEmailJob,
  startEmailWorker,
  type EmailJob,
  type EmailJobDeps,
  type EmailQueueOptions,
  type EmailWorkerOptions,
} from './jobs/email-send.js';
export {
  createPurgeHookRegistry,
  createWorkspacePurgeQueue,
  onWorkspacePurgeFailed,
  processWorkspacePurge,
  startWorkspacePurgeWorker,
  WORKSPACE_PURGE_BACKOFF_BASE_MS,
  WORKSPACE_PURGE_BACKOFF_MAX_MS,
  workspacePurgeBackoff,
  type PurgeCtx,
  type PurgeHook,
  type PurgeHookRegistry,
  type WorkspacePurgeDeps,
  type WorkspacePurgeJob,
  type WorkspacePurgeQueueOptions,
  type WorkspacePurgeWorkerOptions,
} from './jobs/workspace-purge.js';
export {
  createInviteExpiryQueue,
  INVITE_EXPIRY_ATTEMPTS,
  INVITE_EXPIRY_BACKOFF_BASE_MS,
  INVITE_EXPIRY_EVERY_MS,
  INVITE_EXPIRY_FAILED_RETENTION_S,
  INVITE_EXPIRY_QUEUE,
  INVITE_EXPIRY_SCHEDULER_ID,
  INVITE_PURGE_HOOK,
  inviteExpiryJobOptions,
  onInviteExpiryFailed,
  processInviteExpiry,
  registerInvitePurgeHook,
  scheduleInviteExpiry,
  startInviteExpiryWorker,
  type InviteExpiryDeps,
  type InviteExpiryQueueOptions,
  type InviteExpiryWorkerOptions,
} from './jobs/invite-expiry.js';
export { PROJECT_PURGE_HOOK, registerProjectPurgeHook } from './jobs/project-purge.js';
