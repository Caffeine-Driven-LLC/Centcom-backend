/**
 * @centcom/worker: BullMQ jobs: webhooks, notifications, billing, retention. Today: the email
 * delivery job (B032) and the workspace purge (B027). Later lanes add theirs under `src/jobs/`.
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
