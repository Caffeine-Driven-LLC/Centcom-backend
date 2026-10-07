/**
 * The email service (B032): `send` checks and renders an email, applies the per-recipient limit
 * and the idempotency key, and queues it for the worker (BullMQ queue `email-send`, which retries
 * delivery). Unknown templates and bad input fail here, at enqueue time, never at delivery.
 *
 * Owns: everything before the queue. Must not: send inline when the queue or Redis is down (that is
 * a retryable 503), or log a recipient, a parameter or a link.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hasControlChars } from '@centcom/contracts';
import { tooManyRequests, unavailable, validationFailed } from '../errors/app-error.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import type { KeyValue, RateLimitStore } from '../redis/types.js';
import type { RenderedEmail } from './providers.js';
import {
  createTemplateRegistry,
  renderTemplate,
  type TemplateId,
  type TemplateParams,
  type TemplateRegistry,
} from './templates.js';
import { checkSender, EMAIL_DETAILS, normalizeAddress } from './validation.js';

/** The BullMQ queue emails go through. */
export const EMAIL_QUEUE = 'email-send';
/** Delivery attempts per email (the 5th failure dead-letters it). */
export const EMAIL_JOB_ATTEMPTS = 5;
/** The backoff type the email worker's strategy answers to. */
export const EMAIL_BACKOFF_TYPE = 'email';
/** How long a dead-lettered email job is kept for inspection, in seconds. */
export const FAILED_JOB_RETENTION_S = 7 * 24 * 60 * 60;

/** The BullMQ options of an email job (without its id). */
export interface EmailJobDefaults {
  attempts: number;
  backoff: { type: string };
  removeOnComplete: boolean;
  removeOnFail: { age: number };
}

/**
 * The BullMQ options every email job is queued with, whatever queue it goes through: retries and
 * backoff travel with the job, so a producer cannot forget them. A fresh object each call, since
 * BullMQ may write to the options it is given.
 */
export const emailJobOptions = (): EmailJobDefaults => ({
  attempts: EMAIL_JOB_ATTEMPTS,
  backoff: { type: EMAIL_BACKOFF_TYPE },
  // Delivered emails leave Redis at once; dead-lettered ones stay for a week.
  removeOnComplete: true,
  removeOnFail: { age: FAILED_JOB_RETENTION_S },
});
/** Emails of one template to one address per window... */
export const EMAIL_RATE_LIMIT = 5;
/** ...of this many seconds. */
export const EMAIL_RATE_WINDOW_S = 60 * 60;
/** How long an idempotency key is remembered. */
export const EMAIL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** The longest idempotency key. */
export const MAX_EMAIL_IDEMPOTENCY_KEY_LENGTH = 200;

/** A queued email: what the worker hands to the provider. */
export interface EmailJobData {
  template: string;
  email: RenderedEmail;
}

/** The options of one queued email: `emailJobOptions()` and its job id. */
export type EmailJobOptions = EmailJobDefaults & { jobId: string };

/** What the service needs from a queue; a BullMQ `Queue<EmailJobData>` fits. */
export interface EmailQueue {
  add(
    name: string,
    data: EmailJobData,
    opts: EmailJobOptions,
  ): Promise<{ id?: string | undefined }>;
}

/** Options for `createEmailService`. */
export interface EmailServiceOptions {
  queue: EmailQueue;
  /** Per-recipient limits (B009 `RedisBackend.rateLimit`). */
  rateLimit: RateLimitStore;
  /** Idempotency keys (B009 `RedisBackend.kv`). */
  kv: KeyValue;
  /** The sender line (EMAIL_FROM). */
  from: string;
  /** Default: this lane's templates; add more with `registerTemplate`. */
  templates?: TemplateRegistry;
  /** Writes `email.queued` (template and job id only). */
  logger?: Logger;
  /** Receives `email_queued_total{template}` and `email_rate_limited_total{template}`. */
  metrics?: Metrics;
  /** Ids for emails without an idempotency key; default random. */
  newJobId?: () => string;
}

/** Queues emails. */
export interface EmailService {
  /**
   * Checks, renders and queues template `id` for `to`. With `idempotencyKey`, the same key, template
   * and recipient within 24 hours queue nothing more and return the first job id. Throws a 422 for
   * bad input, a 429 (with `retry_after_s`) past the per-recipient limit, a 503 when the queue or
   * Redis fails, and a TypeError for an unknown template.
   */
  send<T extends TemplateId>(
    id: T,
    to: string,
    params: TemplateParams[T],
    opts?: { idempotencyKey?: string },
  ): Promise<{ queued: true; jobId: string }>;
  /** Template `id` rendered for `params` (English; `locale` is accepted for later lanes). */
  render<T extends TemplateId>(
    id: T,
    params: TemplateParams[T],
    locale?: string,
  ): Omit<RenderedEmail, 'to'>;
  /** The templates this service renders. */
  readonly templates: TemplateRegistry;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** An email service over `queue`. Throws a TypeError for a bad sender. */
export function createEmailService(options: EmailServiceOptions): EmailService {
  const { queue, rateLimit, kv, logger } = options;
  const from = checkSender(options.from);
  const templates = options.templates ?? createTemplateRegistry();
  const metrics = options.metrics ?? noopMetrics;
  const newJobId = options.newJobId ?? (() => `email-${randomBytes(16).toString('hex')}`);

  /** Redis and the queue failing are a retryable 503: never an inline send. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      throw unavailable(1, EMAIL_DETAILS.unavailable);
    }
  };

  const render = (id: string, params: unknown): Omit<RenderedEmail, 'to'> => {
    const template = templates.get(id);
    if (template === undefined) throw new TypeError(`unknown email template ${id}`);
    return { ...renderTemplate(id, template, params), from };
  };

  return {
    templates,
    render: (id, params) => render(id, params),

    async send(id, to, params, opts = {}) {
      const recipient = normalizeAddress(to);
      const email: RenderedEmail = { ...render(id, params), to: recipient };
      const key = opts.idempotencyKey;
      if (
        key !== undefined &&
        (typeof key !== 'string' ||
          key.length === 0 ||
          key.length > MAX_EMAIL_IDEMPOTENCY_KEY_LENGTH ||
          hasControlChars(key))
      ) {
        throw validationFailed(
          [
            {
              pointer: '/idempotencyKey',
              code: 'invalid_format',
              detail: 'must be 1 to 200 printable characters',
            },
          ],
          EMAIL_DETAILS.invalid,
        );
      }
      // The key is scoped to the template and recipient, and only its hash is stored.
      const scope = key === undefined ? undefined : sha256(JSON.stringify([key, id, recipient]));
      if (scope !== undefined) {
        const existing = await guarded(() => kv.get(`email:idem:${scope}`));
        if (existing !== null) return { queued: true, jobId: existing };
      }
      const limit = await guarded(() =>
        rateLimit.consume(
          `email:rate:${id}:${sha256(recipient)}`,
          EMAIL_RATE_LIMIT,
          EMAIL_RATE_WINDOW_S,
        ),
      );
      if (!limit.allowed) {
        metrics.counter('email_rate_limited_total', { template: id }).inc();
        throw tooManyRequests(limit.resetS, EMAIL_DETAILS.rateLimited);
      }
      // A key's job id is fixed, so BullMQ itself drops a concurrent duplicate.
      const jobId = scope === undefined ? newJobId() : `email-${scope.slice(0, 32)}`;
      await guarded(() =>
        queue.add(EMAIL_QUEUE, { template: id, email }, { ...emailJobOptions(), jobId }),
      );
      if (scope !== undefined) {
        // The email is queued: failing to remember the key risks a duplicate on a later retry,
        // never a lost email, so it is counted and logged rather than reported as a failure.
        await kv
          .set(`email:idem:${scope}`, jobId, { ttlMs: EMAIL_IDEMPOTENCY_TTL_MS })
          .catch(() => {
            metrics.counter('email_idempotency_unrecorded_total').inc();
            logger?.warn({ template: id, job_id: jobId }, 'email.idempotency_unrecorded');
          });
      }
      metrics.counter('email_queued_total', { template: id }).inc();
      logger?.info({ template: id, job_id: jobId }, 'email.queued');
      return { queued: true, jobId };
    },
  };
}
