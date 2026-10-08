/**
 * Push providers (B064): the interface the three adapters implement (`webpush-provider.ts`,
 * `apns-provider.ts`, `fcm-provider.ts`), what a send can come to, and the guards around them: a
 * semaphore per provider (sends in flight, PUSH_CONCURRENCY_PER_PROVIDER), a circuit breaker per
 * provider (10 failed sends in a row open it for 60 s; deliveries are then deferred, not dropped),
 * and the SSRF guard for web-push endpoints (https only, never a private, loopback, link-local or
 * otherwise internal host, checked at registration and again on the resolved address at send).
 *
 * Owns: the interface and the guards. Must not: log an endpoint, token or key.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** The kinds of subscription (CT-API-NOTIFY `PushSubscription.kind`). */
export type PushKind = 'web_push' | 'apns' | 'fcm';
export const PUSH_KINDS: readonly PushKind[] = ['web_push', 'apns', 'fcm'];

/** Where one push goes (decrypted, in memory only). */
export interface PushTarget {
  id: string;
  kind: PushKind;
  /** The web-push endpoint URL, or the APNs/FCM token. */
  token: string;
  /** Web push only. */
  keys?: { p256dh: string; auth: string };
}

/** What one send came to. */
export type SendOutcome =
  | { result: 'sent' }
  /** The subscription is gone for good (404/410, Unregistered, UNREGISTERED): delete it. */
  | { result: 'gone' }
  /** A transient failure (timeout, 429, 5xx): try again later. */
  | { result: 'retry'; status?: number }
  /** A permanent failure that is not the subscription's fault (bad credentials, 4xx). */
  | { result: 'failed'; status?: number };

/** A push service. */
export interface PushProvider {
  readonly kind: PushKind;
  /** Sends `payload` (CT-NOTIF-PAYLOAD JSON) to `target`; never throws. */
  send(target: PushTarget, payload: Uint8Array, opts: { urgent: boolean }): Promise<SendOutcome>;
}

/** A provider call is abandoned after this long (counted as a retry). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Maps an HTTP status to an outcome: 2xx sent, 404/410 gone, 408/429/5xx retry, else failed. */
export function outcomeOfStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return { result: 'sent' };
  if (status === 404 || status === 410) return { result: 'gone' };
  if (status === 408 || status === 429 || status >= 500) return { result: 'retry', status };
  return { result: 'failed', status };
}

/** At most `max` tasks at once; the rest wait their turn. */
export class Semaphore {
  #active = 0;
  #peak = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('Semaphore: max must be >= 1');
  }

  /** The most tasks that ran at once. */
  get peak(): number {
    return this.#peak;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active += 1;
    this.#peak = Math.max(this.#peak, this.#active);
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

/** Failed sends in a row that open a provider's circuit. */
export const CIRCUIT_THRESHOLD = 10;
/** How long an open circuit stays open. */
export const CIRCUIT_OPEN_MS = 60_000;

/** Opens after CIRCUIT_THRESHOLD failures in a row; closes CIRCUIT_OPEN_MS later. */
export class CircuitBreaker {
  #failures = 0;
  #openUntil = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Milliseconds until the circuit closes; 0 when it is closed. */
  openFor(): number {
    return Math.max(0, this.#openUntil - this.clock());
  }

  success(): void {
    this.#failures = 0;
  }

  failure(): void {
    this.#failures += 1;
    if (this.#failures >= CIRCUIT_THRESHOLD) {
      this.#openUntil = this.clock() + CIRCUIT_OPEN_MS;
      this.#failures = 0;
    }
  }
}

/** True for an IP address no push service may resolve to (private, loopback, link-local...). */
export function isInternalAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d), which URL parsing writes in hex (::ffff:a00:1).
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted?.[1] !== undefined) return isInternalAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex?.[1] !== undefined && hex[2] !== undefined) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isInternalAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Hosts that are never public. */
const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|home|lan|corp)$/i;

/**
 * Why a web-push endpoint is refused, or undefined when it may be registered: an https URL of at
 * most 4096 characters, without credentials, whose host is a public name or a public IP literal.
 */
export function endpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'must be an https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    isIP(host) !== 0 ? isInternalAddress(host) : INTERNAL_NAMES.test(host) || !host.includes('.')
  ) {
    return 'must be a public host';
  }
  return undefined;
}

/** Resolves a host to its addresses (tests replace it). */
export type HostResolver = (host: string) => Promise<string[]>;

/** The system resolver. */
export const dnsResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

/** True when `endpoint`'s host resolves only to public addresses (the send-time SSRF check). */
export async function resolvesPublic(endpoint: string, resolve: HostResolver): Promise<boolean> {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) !== 0 ? [host] : await resolve(host);
    return addresses.length > 0 && addresses.every((a) => !isInternalAddress(a));
  } catch {
    return false;
  }
}
