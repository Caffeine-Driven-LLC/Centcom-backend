/**
 * FCM (B064): HTTP v1 `POST /v1/projects/<project>/messages:send` with an OAuth 2 access token from
 * the service account (an RS256 JWT assertion exchanged at its `token_uri`, scope
 * firebase.messaging, reused until a minute before it expires and dropped on a 401). The message
 * carries the CT-NOTIF-PAYLOAD JSON as the data field `n` (FCM data values are strings), with
 * high Android priority for urgent categories.
 *
 * 200 is sent; 404 or an `UNREGISTERED` error code is gone; 429, 5xx and timeouts (10 s) retry;
 * anything else (bad credentials, invalid argument) failed.
 *
 * Owns: the FCM request and the access token. Must not: log the token, the device token or the
 * payload.
 */
import { createSign } from 'node:crypto';
import type { FcmConfig } from './config.js';
import {
  outcomeOfStatus,
  PROVIDER_TIMEOUT_MS,
  type PushProvider,
  type PushTarget,
  type SendOutcome,
} from './providers.js';

/** The OAuth scope FCM sends need. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** What the FCM provider needs. */
export interface FcmProviderDeps {
  config: FcmConfig;
  /** Default the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  timeoutMs?: number;
}

/** FCM HTTP v1. */
export class FcmProvider implements PushProvider {
  readonly kind = 'fcm' as const;
  #token: { value: string; until: number } | null = null;

  constructor(private readonly deps: FcmProviderDeps) {}

  /** The service account's signed assertion at `nowMs` (RS256, one hour). */
  assertion(nowMs: number): string {
    const { clientEmail, tokenUri, privateKey } = this.deps.config;
    const iat = Math.floor(nowMs / 1000);
    const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iss: clientEmail, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 }),
    )}`;
    const signature = createSign('RSA-SHA256').update(input).sign(privateKey);
    return `${input}.${b64url(signature)}`;
  }

  async #accessToken(signal: AbortSignal): Promise<string | null> {
    const now = (this.deps.clock ?? Date.now)();
    if (this.#token !== null && now < this.#token.until) return this.#token.value;
    const res = await (this.deps.fetch ?? fetch)(this.deps.config.tokenUri, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(now),
      }).toString(),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') return null;
    const ttlS = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.#token = { value: body.access_token, until: now + Math.max(0, ttlS - 60) * 1000 };
    return body.access_token;
  }

  async send(
    target: PushTarget,
    payload: Uint8Array,
    opts: { urgent: boolean },
  ): Promise<SendOutcome> {
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    try {
      const token = await this.#accessToken(signal);
      if (token === null) return { result: 'failed' };
      const { origin, projectId } = this.deps.config;
      const res = await (this.deps.fetch ?? fetch)(
        `${origin.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: target.token,
              data: { n: Buffer.from(payload).toString('utf8') },
              android: { priority: opts.urgent ? 'high' : 'normal' },
            },
          }),
        },
      );
      const text = res.status === 200 ? '' : await res.text().catch(() => '');
      if (res.status === 200) {
        await res.body?.cancel().catch(() => undefined);
        return { result: 'sent' };
      }
      if (res.status === 401) this.#token = null;
      if (
        /"errorCode"\s*:\s*"UNREGISTERED"/.test(text) ||
        /"status"\s*:\s*"NOT_FOUND"/.test(text)
      ) {
        return { result: 'gone' };
      }
      return outcomeOfStatus(res.status);
    } catch {
      return { result: 'retry' };
    }
  }
}
