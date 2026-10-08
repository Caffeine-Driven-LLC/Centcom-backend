/**
 * Web push (B064): RFC 8030 delivery of a payload encrypted with RFC 8291 (`aes128gcm`, ECDH
 * P-256 with the browser's `p256dh` key and `auth` secret) and authorised with RFC 8292 VAPID (an
 * ES256 JWT for the endpoint's origin, 12 h, with PUSH_VAPID_SUBJECT).
 *
 * Before each send the endpoint's host is resolved again and refused when any address is internal
 * (SSRF); redirects are not followed. 2xx is sent, 404/410 gone, 408/429/5xx and timeouts (10 s)
 * retry, any other status failed.
 *
 * Owns: the encryption, the VAPID header and the request. Must not: log the endpoint, the keys or
 * the payload.
 */
import {
  createCipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { VapidConfig } from './config.js';
import {
  dnsResolver,
  outcomeOfStatus,
  PROVIDER_TIMEOUT_MS,
  resolvesPublic,
  type HostResolver,
  type PushProvider,
  type PushTarget,
  type SendOutcome,
} from './providers.js';

/** Record size declared in the aes128gcm header (one record carries the whole payload). */
export const RECORD_SIZE = 4096;
/** How long a push service keeps an undelivered message (TTL header). */
export const WEB_PUSH_TTL_S = 24 * 60 * 60;
/** VAPID tokens live this long (RFC 8292 allows at most 24 h). */
export const VAPID_TTL_S = 12 * 60 * 60;

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * RFC 8291 encryption of `plaintext` for a browser key `uaPublic` (65 bytes) and secret
 * `authSecret` (16 bytes). `salt` and the server's ECDH private key are random unless given
 * (the RFC's test vector gives them).
 */
export function encryptAes128gcm(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  fixed: { salt?: Uint8Array; serverPrivateKey?: Uint8Array } = {},
): Buffer {
  const ecdh = createECDH('prime256v1');
  if (fixed.serverPrivateKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(Buffer.from(fixed.serverPrivateKey));
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(Buffer.from(uaPublic));
  const salt = Buffer.from(fixed.salt ?? randomBytes(16));
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    Buffer.from(uaPublic),
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, Buffer.from(authSecret), keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12),
  );
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The last (and only) record ends with the 0x02 delimiter and no padding.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** An ES256 JWT (RFC 7515/7518, raw r||s signature). */
export function es256Jwt(header: object, payload: object, key: KeyObject): string {
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

/** The RFC 8292 `Authorization` header for `endpoint` at `nowS`. */
export function vapidAuthorization(endpoint: string, vapid: VapidConfig, nowS: number): string {
  const jwt = es256Jwt(
    { typ: 'JWT', alg: 'ES256' },
    { aud: new URL(endpoint).origin, exp: nowS + VAPID_TTL_S, sub: vapid.subject },
    vapid.privateKey,
  );
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

/** What the web push provider needs. */
export interface WebPushProviderDeps {
  vapid: VapidConfig;
  /** Default the global fetch. */
  fetch?: typeof fetch;
  /** Default DNS; tests serve loopback endpoints with their own. */
  resolve?: HostResolver;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  timeoutMs?: number;
}

/** Web push through each subscription's own push service. */
export class WebPushProvider implements PushProvider {
  readonly kind = 'web_push' as const;

  constructor(private readonly deps: WebPushProviderDeps) {}

  async send(
    target: PushTarget,
    payload: Uint8Array,
    opts: { urgent: boolean },
  ): Promise<SendOutcome> {
    if (target.keys === undefined) return { result: 'failed' };
    if (!(await resolvesPublic(target.token, this.deps.resolve ?? dnsResolver))) {
      return { result: 'failed' };
    }
    let body: Buffer;
    try {
      body = encryptAes128gcm(
        payload,
        Buffer.from(target.keys.p256dh, 'base64url'),
        Buffer.from(target.keys.auth, 'base64url'),
      );
    } catch {
      return { result: 'gone' };
    }
    const nowS = Math.floor((this.deps.clock ?? Date.now)() / 1000);
    try {
      const res = await (this.deps.fetch ?? fetch)(target.token, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        headers: {
          authorization: vapidAuthorization(target.token, this.deps.vapid, nowS),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(WEB_PUSH_TTL_S),
          urgency: opts.urgent ? 'high' : 'normal',
        },
        body,
      });
      await res.body?.cancel().catch(() => undefined);
      return outcomeOfStatus(res.status);
    } catch {
      return { result: 'retry' };
    }
  }
}
