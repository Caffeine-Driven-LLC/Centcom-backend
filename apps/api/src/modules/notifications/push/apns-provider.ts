/**
 * APNs (B064): token-based provider authentication (an ES256 JWT with the team id and key id,
 * renewed every 50 minutes, as Apple requires between 20 and 60) and one HTTP/2 connection to
 * PUSH_APNS_ORIGIN, reopened when it closes. A push is `POST /3/device/<token>` with the app's
 * topic; the body is `{aps: {alert: {title-loc-key, loc-key}, mutable-content: 1}, n: <payload>}`
 * so the app renders text from its own message table (CT-NOTIF-PAYLOAD keys only).
 *
 * 200 is sent; 410 (Unregistered) and 400 BadDeviceToken are gone; 429, 5xx and timeouts (10 s)
 * retry; anything else (bad credentials, wrong topic) failed.
 *
 * Owns: the APNs request. Must not: log the device token or the payload.
 */
import { connect, type ClientHttp2Session } from 'node:http2';
import type { ApnsConfig } from './config.js';
import {
  outcomeOfStatus,
  PROVIDER_TIMEOUT_MS,
  type PushProvider,
  type PushTarget,
  type SendOutcome,
} from './providers.js';
import { es256Jwt } from './webpush-provider.js';

/** A provider token is reused this long. */
export const APNS_TOKEN_TTL_MS = 50 * 60_000;

/** What the APNs provider needs. */
export interface ApnsProviderDeps {
  config: ApnsConfig;
  /** Opens the HTTP/2 session; default `http2.connect`. */
  connect?: (origin: string) => ClientHttp2Session;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  timeoutMs?: number;
}

/** The APNs body for a CT-NOTIF-PAYLOAD JSON. */
export function apnsBody(payload: Uint8Array): Buffer {
  const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>;
  return Buffer.from(
    JSON.stringify({
      aps: {
        alert: { 'title-loc-key': parsed['title_key'], 'loc-key': parsed['body_key'] },
        'mutable-content': 1,
      },
      n: parsed,
    }),
  );
}

/** APNs over HTTP/2. */
export class ApnsProvider implements PushProvider {
  readonly kind = 'apns' as const;
  #session: ClientHttp2Session | null = null;
  #token: { jwt: string; at: number } | null = null;

  constructor(private readonly deps: ApnsProviderDeps) {}

  /** The provider token, renewed every 50 minutes. */
  providerToken(): string {
    const now = (this.deps.clock ?? Date.now)();
    if (this.#token === null || now - this.#token.at >= APNS_TOKEN_TTL_MS) {
      const { teamId, keyId, privateKey } = this.deps.config;
      this.#token = {
        jwt: es256Jwt(
          { alg: 'ES256', kid: keyId },
          { iss: teamId, iat: Math.floor(now / 1000) },
          privateKey,
        ),
        at: now,
      };
    }
    return this.#token.jwt;
  }

  #connection(): ClientHttp2Session {
    if (this.#session === null || this.#session.closed || this.#session.destroyed) {
      const session = (this.deps.connect ?? connect)(this.deps.config.origin);
      session.on('error', () => undefined);
      session.on('close', () => {
        if (this.#session === session) this.#session = null;
      });
      session.unref();
      this.#session = session;
    }
    return this.#session;
  }

  send(target: PushTarget, payload: Uint8Array, opts: { urgent: boolean }): Promise<SendOutcome> {
    return new Promise<SendOutcome>((resolve) => {
      let settled = false;
      const done = (outcome: SendOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      let body: Buffer;
      try {
        body = apnsBody(payload);
      } catch {
        done({ result: 'failed' });
        return;
      }
      try {
        const request = this.#connection().request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(target.token)}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': this.deps.config.topic,
          'apns-push-type': 'alert',
          'apns-priority': opts.urgent ? '10' : '5',
          'content-type': 'application/json',
        });
        request.setTimeout(this.deps.timeoutMs ?? PROVIDER_TIMEOUT_MS, () => {
          request.close();
          done({ result: 'retry' });
        });
        let status = 0;
        const chunks: Buffer[] = [];
        request.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        request.on('data', (chunk: Buffer) => {
          if (chunks.length < 8) chunks.push(chunk);
        });
        request.on('end', () => {
          if (status === 400) {
            const reason = /"reason"\s*:\s*"([A-Za-z]+)"/.exec(
              Buffer.concat(chunks).toString('utf8'),
            )?.[1];
            done(reason === 'BadDeviceToken' ? { result: 'gone' } : { result: 'failed', status });
            return;
          }
          done(outcomeOfStatus(status));
        });
        request.on('error', () => done({ result: 'retry' }));
        request.end(body);
      } catch {
        done({ result: 'retry' });
      }
    });
  }

  /** Closes the connection. */
  close(): void {
    this.#session?.close();
    this.#session = null;
  }
}
