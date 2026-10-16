/**
 * More email providers: Resend and Brevo over HTTPS with the platform `fetch` (no SDK), and a
 * small SMTP client over `node:net` and `node:tls` (implicit TLS, STARTTLS or plain, AUTH PLAIN).
 * They share Postmark's contract (`EmailProvider`): a 4xx or SMTP 5xx answer is permanent, a
 * timeout, network error, 429/5xx or SMTP 4xx is retryable.
 *
 * Owns: each service's request mapping, the SMTP dialogue and the MIME message. Must not: put an
 * API key, a password, a recipient or the provider's own error text into an error or a log line,
 * send over an unencrypted link unless `secure` says `none`, or accept a header value with a line
 * break.
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { Secret } from '../config/secret.js';
import {
  EmailProviderError,
  parseRetryAfter,
  type EmailProvider,
  type RenderedEmail,
} from './providers.js';

/** Splits `Display Name <address>` or `address` (the sender rules already checked the shape). */
export function splitSender(line: string): { name: string | undefined; address: string } {
  const match = /^(.*) <([^<>]+)>$/.exec(line);
  return match === null
    ? { name: undefined, address: line }
    : { name: match[1] as string, address: match[2] as string };
}

/** What a JSON-over-HTTPS provider needs from one request. */
interface HttpCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Reads the message id out of a successful reply; undefined: malformed. */
  messageId(body: unknown): string | undefined;
  fetch: typeof fetch;
}

/** POSTs `call` and maps the answer to the shared result or error split. */
async function postJson(
  call: HttpCall,
  signal: AbortSignal,
): Promise<{ providerMessageId: string }> {
  let response: Response;
  try {
    response = await call.fetch(call.url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...call.headers },
      body: JSON.stringify(call.body),
      signal,
    });
  } catch {
    throw new EmailProviderError(signal.aborted ? 'timeout' : 'network', { retryable: true });
  }
  const status = response.status;
  if (response.ok) {
    const id = call.messageId(await response.json().catch(() => undefined));
    if (id === undefined || id === '') {
      throw new EmailProviderError('malformed_reply', { retryable: true, status });
    }
    return { providerMessageId: id };
  }
  // Only the status is kept: the provider's error text can quote the recipient.
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

const idOf =
  (key: string) =>
  (body: unknown): string | undefined => {
    const value = (body as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' ? value : undefined;
  };

/** Resend's API. */
export const RESEND_API_URL = 'https://api.resend.com';

/** Options for ResendProvider. */
export interface ResendOptions {
  /** The API key (RESEND_API_KEY). */
  apiKey: Secret;
  /** The API base URL; tests point it at a stub. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Sends through Resend's `POST /emails`. */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  readonly #key: Secret;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: ResendOptions) {
    this.#key = options.apiKey;
    this.#url = `${(options.baseUrl ?? RESEND_API_URL).replace(/\/+$/, '')}/emails`;
    this.#fetch = options.fetch ?? fetch;
  }

  send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }> {
    return postJson(
      {
        url: this.#url,
        headers: { authorization: `Bearer ${this.#key.reveal()}` },
        body: {
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          tags: [{ name: 'template', value: msg.tag.replace(/[^A-Za-z0-9_-]/g, '_') }],
        },
        messageId: idOf('id'),
        fetch: this.#fetch,
      },
      signal,
    );
  }
}

/** Brevo's API. */
export const BREVO_API_URL = 'https://api.brevo.com';

/** Options for BrevoProvider. */
export interface BrevoOptions {
  /** The API key (BREVO_API_KEY). */
  apiKey: Secret;
  /** The API base URL; tests point it at a stub. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Sends through Brevo's `POST /v3/smtp/email`. */
export class BrevoProvider implements EmailProvider {
  readonly name = 'brevo';
  readonly #key: Secret;
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: BrevoOptions) {
    this.#key = options.apiKey;
    this.#url = `${(options.baseUrl ?? BREVO_API_URL).replace(/\/+$/, '')}/v3/smtp/email`;
    this.#fetch = options.fetch ?? fetch;
  }

  send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }> {
    const sender = splitSender(msg.from);
    return postJson(
      {
        url: this.#url,
        headers: { 'api-key': this.#key.reveal() },
        body: {
          sender: {
            email: sender.address,
            ...(sender.name === undefined ? {} : { name: sender.name }),
          },
          to: [{ email: msg.to }],
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
          tags: [msg.tag],
        },
        messageId: idOf('messageId'),
        fetch: this.#fetch,
      },
      signal,
    );
  }
}

/** How the SMTP link is protected. */
export type SmtpSecure = 'tls' | 'starttls' | 'none';

/**
 * True for an address that never leaves this machine: `localhost`, 127.0.0.0/8 and ::1. A name that merely resolves
 * to one is not trusted (DNS can change), only these literals.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Options for SmtpProvider. */
export interface SmtpOptions {
  host: string;
  port: number;
  /** `tls`: encrypted from the first byte (port 465); `starttls`: upgrade, required (587); `none`: plain. */
  secure: SmtpSecure;
  user?: string;
  password?: Secret;
  /** The name said in EHLO; default `centcom`. */
  clientName?: string;
  /** Extra TLS options (tests pass a CA). */
  tls?: ConnectionOptions;
  /**
   * Send the user name and password over a connection that is not encrypted (`secure: 'none'`) to a host that is
   * not on this machine. Refused unless this is true (SMTP_ALLOW_CLEARTEXT_AUTH): anyone on the path would read the password.
   */
  allowCleartextAuth?: boolean;
}

/** One SMTP reply: the code and the text lines (without the code). */
interface SmtpReply {
  code: number;
  lines: string[];
}

/** A socket read as SMTP replies. */
interface Wire {
  socket: Socket | TLSSocket;
  read(): Promise<SmtpReply>;
  write(line: string): void;
}

const MAX_REPLY_BYTES = 64 * 1024;

function wire(socket: Socket | TLSSocket): Wire {
  let buffer = '';
  let lines: string[] = [];
  const replies: SmtpReply[] = [];
  let failure: Error | undefined;
  let waiter: { resolve(r: SmtpReply): void; reject(e: Error): void } | undefined;
  const settle = (): void => {
    if (waiter === undefined) return;
    const next = replies.shift();
    if (next !== undefined) {
      const w = waiter;
      waiter = undefined;
      w.resolve(next);
    } else if (failure !== undefined) {
      const w = waiter;
      waiter = undefined;
      w.reject(failure);
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_REPLY_BYTES) {
      failure = new Error('reply too long');
      socket.destroy();
    }
    let eol = buffer.indexOf('\n');
    while (eol >= 0) {
      const line = buffer.slice(0, eol).replace(/\r$/, '');
      buffer = buffer.slice(eol + 1);
      const m = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (m === null) {
        failure = new Error('malformed reply');
        socket.destroy();
      } else {
        lines.push(m[3] ?? '');
        if (m[2] !== '-') {
          replies.push({ code: Number(m[1]), lines });
          lines = [];
        }
      }
      eol = buffer.indexOf('\n');
    }
    settle();
  });
  const end = (): void => {
    failure ??= new Error('connection closed');
    settle();
  };
  socket.on('error', end);
  socket.on('close', end);
  return {
    socket,
    read: () =>
      new Promise<SmtpReply>((resolve, reject) => {
        waiter = { resolve, reject };
        settle();
      }),
    write: (line) => void socket.write(`${line}\r\n`),
  };
}

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64');
const wrap76 = (value: string): string => value.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const isAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);
/** RFC 2047 encoded word for non-ASCII header text. */
const encodedWord = (value: string): string =>
  isAscii(value) ? value : `=?UTF-8?B?${b64(value)}?=`;

/** Builds the MIME message (multipart/alternative, base64 parts, dot-stuffed by the caller). */
export function buildMime(msg: RenderedEmail, now: Date, messageId: string): string {
  for (const field of [msg.to, msg.from, msg.subject, msg.tag]) {
    if (/[\r\n]/.test(field)) throw new EmailProviderError('rejected', { retryable: false });
  }
  const sender = splitSender(msg.from);
  const from =
    sender.name === undefined
      ? sender.address
      : `${isAscii(sender.name) ? sender.name : encodedWord(sender.name)} <${sender.address}>`;
  const boundary = `=_centcom_${randomBytes(12).toString('hex')}`;
  const part = (type: string, body: string): string =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(body))}\r\n`;
  return [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${encodedWord(msg.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `X-Centcom-Template: ${msg.tag}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', msg.text) + part('text/html', msg.html) + `--${boundary}--`,
  ].join('\r\n');
}

/** Sends through an SMTP server (port 465 with `tls`, 587 with `starttls`). */
export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly #o: SmtpOptions;

  constructor(options: SmtpOptions) {
    if (
      options.secure === 'none' &&
      (options.user !== undefined || options.password !== undefined) &&
      !isLoopbackHost(options.host) &&
      options.allowCleartextAuth !== true
    ) {
      throw new TypeError(
        'the smtp provider would send credentials in clear text to a host that is not this machine: use SMTP_SECURE=starttls or tls, or set SMTP_ALLOW_CLEARTEXT_AUTH=true',
      );
    }
    this.#o = options;
  }

  async send(msg: RenderedEmail, signal: AbortSignal): Promise<{ providerMessageId: string }> {
    let socket: Socket | TLSSocket | undefined;
    const abort = (): void => void socket?.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await this.#dialogue(
        msg,
        (s) => {
          socket = s;
        },
        signal,
      );
    } catch (err) {
      if (err instanceof EmailProviderError) throw err;
      throw new EmailProviderError(signal.aborted ? 'timeout' : 'network', { retryable: true });
    } finally {
      signal.removeEventListener('abort', abort);
      socket?.destroy();
    }
  }

  /** Reads one reply and requires a code in `ok`; maps others to the shared error split. */
  async #expect(w: Wire, ok: number[]): Promise<SmtpReply> {
    const reply = await w.read();
    if (ok.includes(reply.code)) return reply;
    if (reply.code >= 400 && reply.code < 500) {
      throw new EmailProviderError('unavailable', { retryable: true, status: reply.code });
    }
    throw new EmailProviderError('rejected', { retryable: false, status: reply.code });
  }

  async #dialogue(
    msg: RenderedEmail,
    hold: (s: Socket | TLSSocket) => void,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string }> {
    const o = this.#o;
    const name = o.clientName ?? 'centcom';
    const servername = o.host;
    const opened = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const s =
        o.secure === 'tls'
          ? tlsConnect({ host: o.host, port: o.port, servername, ...o.tls })
          : netConnect({ host: o.host, port: o.port });
      hold(s);
      s.once('error', reject);
      s.once(o.secure === 'tls' ? 'secureConnect' : 'connect', () => {
        s.off('error', reject);
        resolve(s);
      });
      if (signal.aborted) s.destroy(new Error('aborted'));
    });
    let w = wire(opened);
    await this.#expect(w, [220]);
    w.write(`EHLO ${name}`);
    const ehlo = await this.#expect(w, [250]);
    if (o.secure === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS$/i.test(l.trim()))) {
        throw new EmailProviderError('rejected', { retryable: false });
      }
      w.write('STARTTLS');
      await this.#expect(w, [220]);
      opened.removeAllListeners('data');
      const upgraded = tlsConnect({ socket: opened, servername, ...o.tls });
      hold(upgraded);
      await new Promise<void>((resolve, reject) => {
        upgraded.once('error', reject);
        upgraded.once('secureConnect', () => resolve());
      });
      w = wire(upgraded);
      w.write(`EHLO ${name}`);
      await this.#expect(w, [250]);
    }
    if (o.user !== undefined && o.password !== undefined) {
      w.write(`AUTH PLAIN ${b64(`\0${o.user}\0${o.password.reveal()}`)}`);
      await this.#expect(w, [235]);
    }
    const from = splitSender(msg.from).address;
    const domain = from.slice(from.indexOf('@') + 1);
    const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;
    const mime = buildMime(msg, new Date(), messageId);
    w.write(`MAIL FROM:<${from}>`);
    await this.#expect(w, [250]);
    w.write(`RCPT TO:<${msg.to}>`);
    await this.#expect(w, [250, 251]);
    w.write('DATA');
    await this.#expect(w, [354]);
    // Dot-stuffing: a line that starts with "." gets a second one.
    w.write(`${mime.replace(/^\./gm, '..')}\r\n.`);
    await this.#expect(w, [250]);
    w.write('QUIT');
    return { providerMessageId: messageId };
  }
}
