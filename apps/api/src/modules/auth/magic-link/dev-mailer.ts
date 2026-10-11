/**
 * A development `MagicLinkMailer` (B102): hands the sign-in mail to Mailpit's HTTP API
 * (`POST /api/v1/send`), the mail catcher of `pnpm dev:up`, with the `magic_link` template's copy.
 * Production mail goes through B032's email service and its worker; this file is for the local
 * stack and the end-to-end test.
 *
 * Owns: the Mailpit call. Must not: log the link or the address, or wait longer than its timeout.
 */
import { MAGIC_LINK_TEMPLATE, lifetime, type MagicLinkMailer } from './mailer.js';

/** How long Mailpit gets to take a message. */
export const DEV_MAIL_TIMEOUT_MS = 5_000;

/** Options for `mailpitMailer`. */
export interface MailpitMailerOptions {
  /** Mailpit's HTTP address, such as `http://127.0.0.1:8025`. */
  url: string;
  /** The sender address. */
  from: string;
  /** The links' lifetime in seconds, for the copy. */
  ttlS: number;
  /** For tests; default `fetch`. */
  fetch?: typeof fetch;
}

export function mailpitMailer(options: MailpitMailerOptions): MagicLinkMailer {
  const send = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, '')}/api/v1/send`;
  const validFor = lifetime(options.ttlS);
  return {
    async send(to, link) {
      const params = { url: link, validFor };
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Email: options.from },
          To: [{ Email: to }],
          Subject: MAGIC_LINK_TEMPLATE.subject(params),
          Text: MAGIC_LINK_TEMPLATE.text(params),
          HTML: String(MAGIC_LINK_TEMPLATE.html(params)),
        }),
        signal: AbortSignal.timeout(DEV_MAIL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`mail catcher answered ${response.status}`);
    },
  };
}
