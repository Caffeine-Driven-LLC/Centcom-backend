/**
 * One webhook HTTP attempt (B081, CT-WEBHOOKS "Delivery"): `POST` the exact body to the checked
 * address (destination.ts) with the original host name for Host and TLS SNI, never resolving the
 * name again; at most 10 s from start to finish; no redirects followed (301/302 count as failures);
 * no cookies or credentials; at most 64 KiB of the response read, and only its first 1 KiB, with
 * control characters removed, kept for the delivery log.
 *
 * Owns: the socket. Must not: log the body, a header value, or the response.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Destination } from './destination.js';

/** The whole attempt, at most. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Response bytes read, at most. */
export const MAX_RESPONSE_READ = 64 * 1024;
/** Response characters kept in the delivery log. */
export const MAX_RESPONSE_EXCERPT = 1024;

/** How one attempt ended. */
export type AttemptOutcome =
  | { ok: true; status: number; durationMs: number; excerpt: string }
  | {
      ok: false;
      error: 'timeout' | 'connection' | 'redirect' | 'http_status';
      status: number | null;
      durationMs: number;
      excerpt: string | null;
    };

/** One attempt's request. */
export interface AttemptRequest {
  destination: Destination;
  body: string;
  headers: Record<string, string>;
  /** Default WEBHOOK_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Sends one attempt (tests replace it). */
export type WebhookSender = (req: AttemptRequest) => Promise<AttemptOutcome>;

/** C0 and C1 control characters. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Keeps the log excerpt: control characters removed, at most 1 KiB. */
export function excerptOf(raw: Buffer): string {
  return raw.toString('utf8').replace(CONTROL, '').slice(0, MAX_RESPONSE_EXCERPT);
}

/** The real sender, over node:http(s). */
export const httpSender: WebhookSender = (req) =>
  new Promise((resolve) => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    const { url, address, family } = req.destination;
    // Connect to the checked address only, whatever the name would resolve to now.
    const lookup: LookupFunction = (_host, options, callback) => {
      if ((options as { all?: boolean }).all === true) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address, family },
        ]);
      } else {
        callback(null, address, family);
      }
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (outcome: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const request = send(
      url,
      {
        method: 'POST',
        lookup,
        headers: {
          ...req.headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(req.body)),
          'user-agent': 'Centcom-Webhooks/1',
        },
        // No connection reuse across endpoints: each attempt checks its own destination.
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let read = 0;
        response.on('data', (chunk: Buffer) => {
          if (read < MAX_RESPONSE_READ) {
            chunks.push(chunk.subarray(0, MAX_RESPONSE_READ - read));
            read += chunk.length;
          }
          if (read >= MAX_RESPONSE_READ) response.destroy();
        });
        const done = (): void => {
          const excerpt = excerptOf(Buffer.concat(chunks));
          if (status >= 200 && status < 300) {
            finish({ ok: true, status, durationMs: elapsed(), excerpt });
          } else {
            finish({
              ok: false,
              error: status >= 300 && status < 400 ? 'redirect' : 'http_status',
              status,
              durationMs: elapsed(),
              excerpt,
            });
          }
        };
        response.on('end', done);
        response.on('close', done);
        response.on('error', done);
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, error: 'timeout', status: null, durationMs: elapsed(), excerpt: null });
    }, req.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
    request.on('error', () => {
      finish({
        ok: false,
        error: 'connection',
        status: null,
        durationMs: elapsed(),
        excerpt: null,
      });
    });
    request.end(req.body);
  });
