/**
 * @centcom/worker: BullMQ jobs: webhooks, notifications, billing, retention. Today: the email
 * delivery job (B032). Later lanes add theirs under `src/jobs/`.
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
