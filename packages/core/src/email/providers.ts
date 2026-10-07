/**
 * Email providers (B032): what sends a rendered email. Postmark over HTTPS with the platform
 * `fetch` (no SDK); an in-memory provider for tests and development; and a console provider that
 * only logs which template would have gone out.
 *
 * Owns: the provider interface, Postmark's API mapping and the retryable/permanent split. Must not:
 * put the server token, a recipient or a provider's own error text into an error or a log line.
 */
import type { Secret } from '../config/secret.js';
import type { Logger } from '../log/logger.js';

/** An email ready to hand to a provider. */
export interface RenderedEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /** The template id. */
  tag: string;
}

/** Sends emails. */
export interface EmailProvider {
  readonly name: string;
  /** Sends `msg`; aborts when `signal` does. Throws an EmailProviderError on failure. */
  send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }>;
}

/** Why a send failed. */
export type EmailFailure = 'timeout' | 'network' | 'unavailable' | 'rejected' | 'malformed_reply';

/**
 * A failed send. `retryable` sends may succeed later (timeouts, network errors, 429 and 5xx, after
 * `retryAfterMs` when the provider said so); the rest (4xx but 429) never will.
 */
export class EmailProviderError extends Error {
  override name = 'EmailProviderError';
  readonly failure: EmailFailure;
  readonly retryable: boolean;
  /** The provider's HTTP status, when it answered. */
  readonly status?: number;
  /** How long the provider asked us to wait. */
  readonly retryAfterMs?: number;

  constructor(
    failure: EmailFailure,
    options: { retryable: boolean; status?: number; retryAfterMs?: number },
  ) {
    super(
      `email provider: ${failure}${options.status === undefined ? '' : ` (${options.status})`}`,
    );
    this.failure = failure;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** The longest Retry-After honoured. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** A Retry-After header (seconds or an HTTP date) in milliseconds, capped; undefined if unusable. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = /^\s*\d{1,9}\s*$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_MS);
}

/** Postmark's API. */
export const POSTMARK_API_URL = 'https://api.postmarkapp.com';

/** Options for PostmarkProvider. */
export interface PostmarkOptions {
  /** The server token (POSTMARK_SERVER_TOKEN). */
  token: Secret;
  /** The API base URL; tests point it at a stub. */
  baseUrl?: string;
  /** Postmark's message stream; default `outbound` (transactional). */
  messageStream?: string;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
}

/** Sends through Postmark's `POST /email`. */
export class PostmarkProvider implements EmailProvider {
  readonly name = 'postmark';
  readonly #token: Secret;
  readonly #url: string;
  readonly #stream: string;
  readonly #fetch: typeof fetch;

  constructor(options: PostmarkOptions) {
    this.#token = options.token;
    this.#url = `${(options.baseUrl ?? POSTMARK_API_URL).replace(/\/+$/, '')}/email`;
    this.#stream = options.messageStream ?? 'outbound';
    this.#fetch = options.fetch ?? fetch;
  }

  async send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': this.#token.reveal(),
        },
        body: JSON.stringify({
          From: msg.from,
          To: msg.to,
          Subject: msg.subject,
          HtmlBody: msg.html,
          TextBody: msg.text,
          Tag: msg.tag,
          MessageStream: this.#stream,
          TrackOpens: false,
          TrackLinks: 'None',
        }),
        signal,
      });
    } catch {
      throw new EmailProviderError(signal.aborted ? 'timeout' : 'network', { retryable: true });
    }
    const status = response.status;
    if (response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        { MessageID?: unknown } | undefined;
      if (typeof body?.MessageID !== 'string' || body.MessageID === '') {
        throw new EmailProviderError('malformed_reply', { retryable: true, status });
      }
      return { providerMessageId: body.MessageID };
    }
    // Only the status is kept: Postmark's own error text can quote the recipient.
    await response.body?.cancel().catch(() => undefined);
    if (status === 429 || status >= 500) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new EmailProviderError('unavailable', {
        retryable: true,
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    throw new EmailProviderError('rejected', { retryable: false, status });
  }
}

/** Keeps every email in `sent` (tests and development). */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: RenderedEmail[] = [];
  /** When set, called before each send; an error it returns is thrown instead of sending. */
  failNext?: (msg: RenderedEmail) => Error | undefined;

  send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }> {
    if (signal.aborted)
      return Promise.reject(new EmailProviderError('timeout', { retryable: true }));
    const failure = this.failNext?.(msg);
    if (failure !== undefined) return Promise.reject(failure);
    this.sent.push({ ...msg });
    return Promise.resolve({ providerMessageId: `memory-${this.sent.length}` });
  }
}

/** Logs the template of each email and sends nothing (local development). */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  readonly #logger: Logger;
  #count = 0;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  send(msg: RenderedEmail): Promise<{ providerMessageId: string }> {
    this.#count += 1;
    const providerMessageId = `console-${this.#count}`;
    this.#logger.info(
      { template: msg.tag, provider_message_id: providerMessageId },
      'email.console',
    );
    return Promise.resolve({ providerMessageId });
  }
}
