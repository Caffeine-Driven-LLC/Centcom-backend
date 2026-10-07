/**
 * Test helpers for idempotency (B024): stores over a harness's KeyValue with quick polling, a
 * KeyValue that fails on demand, encryption keys and responses made at run time.
 */
import { randomBytes } from 'node:crypto';
import {
  createIdempotencyStore,
  fingerprintRequest,
  Secret,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
  type KeyValue,
  type StoredResponse,
} from '../../src/index.js';
import { captureLogger, countingMetrics } from '../redis/helpers.js';

export { captureLogger, countingMetrics };

/** A fresh 32-byte key. */
export const newKey = (): Secret<Uint8Array> => new Secret(new Uint8Array(randomBytes(32)));

/** A fingerprint for a body. */
export const fp = (body: unknown): string => fingerprintRequest('POST', '/v1/things', {}, body);

/** A JSON response. */
export const jsonResponse = (status: number, body: unknown, headers = {}): StoredResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: Buffer.from(JSON.stringify(body), 'utf8'),
});

/** A store over `kv` that polls every millisecond and waits `inFlightWaitMs` (default 2 s). */
export function quickStore(
  kv: KeyValue,
  options: Partial<IdempotencyStoreOptions> = {},
): IdempotencyStore {
  return createIdempotencyStore({
    kv,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    inFlightWaitMs: 2_000,
    ...options,
  });
}

/** `inner`, unless `down`: then every call rejects. */
export function flakyKv(inner: KeyValue): KeyValue & { down: boolean } {
  const fail = (): Promise<never> => Promise.reject(new Error('kv down'));
  const kv: KeyValue & { down: boolean } = {
    down: false,
    get: (key) => (kv.down ? fail() : inner.get(key)),
    set: (key, value, opts) => (kv.down ? fail() : inner.set(key, value, opts)),
    setIfAbsent: (key, value, ttlMs) => (kv.down ? fail() : inner.setIfAbsent(key, value, ttlMs)),
    del: (key) => (kv.down ? fail() : inner.del(key)),
    incr: (key, ttlMs) => (kv.down ? fail() : inner.incr(key, ttlMs)),
    ttl: (key) => (kv.down ? fail() : inner.ttl(key)),
  };
  return kv;
}
