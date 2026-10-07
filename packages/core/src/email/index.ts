/**
 * Transactional email (B032): templates with typed parameters and escaping, input rules, providers
 * (Postmark, memory, console), the service that queues emails, and configuration. The BullMQ job
 * that delivers them is `apps/worker/src/jobs/email-send.ts`. See README.md in this package.
 */
export {
  createEmailProvider,
  DEFAULT_EMAIL_TIMEOUT_MS,
  EMAIL_PROVIDERS,
  emailConfig,
  emailEnvSchema,
  type EmailConfig,
  type EmailProviderName,
} from './config.js';
export {
  ConsoleEmailProvider,
  EmailProviderError,
  MAX_RETRY_AFTER_MS,
  MemoryEmailProvider,
  parseRetryAfter,
  POSTMARK_API_URL,
  PostmarkProvider,
  type EmailFailure,
  type EmailProvider,
  type PostmarkOptions,
  type RenderedEmail,
} from './providers.js';
export {
  createEmailService,
  EMAIL_BACKOFF_TYPE,
  EMAIL_IDEMPOTENCY_TTL_MS,
  EMAIL_JOB_ATTEMPTS,
  EMAIL_QUEUE,
  EMAIL_RATE_LIMIT,
  EMAIL_RATE_WINDOW_S,
  emailJobOptions,
  FAILED_JOB_RETENTION_S,
  MAX_EMAIL_IDEMPOTENCY_KEY_LENGTH,
  type EmailJobData,
  type EmailJobDefaults,
  type EmailJobOptions,
  type EmailQueue,
  type EmailService,
  type EmailServiceOptions,
} from './service.js';
export {
  BUILT_IN_TEMPLATES,
  createTemplateRegistry,
  escapeHtml,
  formatDate,
  markup,
  renderTemplate,
  type BuiltInTemplateId,
  type EmailTemplate,
  type ParamKind,
  type RenderedContent,
  type SafeHtml,
  type TemplateId,
  type TemplateParams,
  type TemplateRegistry,
} from './templates.js';
export {
  checkSender,
  EMAIL_DETAILS,
  hasLineBreak,
  isAddress,
  MAX_ADDRESS_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TEXT_PARAM_LENGTH,
  MAX_URL_LENGTH,
  normalizeAddress,
} from './validation.js';
