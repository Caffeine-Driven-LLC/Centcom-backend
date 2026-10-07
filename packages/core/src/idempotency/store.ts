/**
 * Idempotency records (B024, CT-PAGE): what is kept under an `Idempotency-Key` in B009's
 * KeyValue. Claiming a key writes an in-flight lock (30 s) atomically; completing it replaces the
 * lock with the response (status, a safe subset of headers, the body, sealed for sensitive
 * routes) for 24 hours; releasing it (a 5xx, an unstorable response) deletes the lock so a retry
 * runs again. One store key per (principal, method, route template, Idempotency-Key).
 *
 * Owns: the record format, store keys, claiming (with the CT-PAGE wait for an in-flight
 * duplicate), completing and releasing. Must not: keep secret-bearing headers or a sensitive body
 * in plaintext, replay a record whose fingerprint differs, or replay a record it cannot verify.
 */
import { createHash } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { Secret } from '../config/secret.js';
import { validationFailed } from '../errors/app-error.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import { MAX_VALUE_BYTES, type KeyValue } from '../redis/types.js';
import { openBody, sealBody } from './crypto.js';
import { fingerprintsEqual } from './fingerprint.js';

/** How long a response is replayed. */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an in-flight lock outlives a crashed process. */
export const LOCK_TTL_MS = 30_000;
/** How long a duplicate waits for an in-flight request's result (CT-PAGE). */
export const IN_FLIGHT_WAIT_MS = 10_000;
/** The largest body stored, unless the route sets its own (`maxStoredBytes`). */
export const DEFAULT_MAX_STORED_BYTES = 256 * 1024;
/** The largest `maxStoredBytes` a route may set (usage ingest). */
export const MAX_STORED_BYTES = 1024 * 1024;
/** The response headers kept with a record; anything else (Set-Cookie, ...) is never stored. */
export const STORED_HEADERS: readonly string[] = Object.freeze([
  'content-type',
  'content-language',
  'location',
  'etag',
  'last-modified',
]);

/** The user-facing details of idempotency problems (GUIDELINES §3.4: one message table). */
export const IDEMPOTENCY_DETAILS = Object.freeze({
  keyRequired: 'This endpoint needs an Idempotency-Key header: a ULID or a UUID.',
  keyInvalid: 'The Idempotency-Key header must be a ULID or a UUID.',
  conflict: 'This Idempotency-Key was already used with a different request.',
  inFlight: 'A request with this Idempotency-Key is still running. Try again shortly.',
  unavailable: 'Idempotency keys cannot be checked right now. Try again shortly.',
} as const);

/** The longest Idempotency-Key accepted (CT-PAGE). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;
/** Where a problem with the header points (`errors[].pointer`). */
export const IDEMPOTENCY_KEY_POINTER = '/headers/idempotency-key';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key an `Idempotency-Key` header carries (a ULID in upper case, a UUID in lower case), or
 * undefined when there is no header. Throws a 422 `validation_failed` pointing at the header for
 * anything else: too long, not one ULID or UUID, or repeated.
 */
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = Array.isArray(header) ? header.join(',') : header;
  const tooLong = value.length > MAX_IDEMPOTENCY_KEY_LENGTH;
  if (!tooLong && ULID.test(value)) return value.toUpperCase();
  if (!tooLong && UUID.test(value)) return value.toLowerCase();
  throw validationFailed(
    [
      {
        pointer: IDEMPOTENCY_KEY_POINTER,
        code: tooLong ? 'too_long' : 'invalid_format',
        detail: tooLong
          ? `must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
          : 'must be a ULID or a UUID',
      },
    ],
    IDEMPOTENCY_DETAILS.keyInvalid,
  );
}

/** A response to keep or replay. */
export interface StoredResponse {
  status: number;
  /** Lower-case names; only STORED_HEADERS are kept. */
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

interface LockRecord {
  v: 1;
  state: 'running';
  fp: string;
  at: number;
}

interface DoneRecord {
  v: 1;
  state: 'done';
  fp: string;
  at: number;
  status: number;
  headers: Record<string, string>;
  /** utf8 text, base64 bytes, or a sealed body (base64 ciphertext with `iv` and `tag`). */
  enc: 'utf8' | 'base64' | 'aes-256-gcm';
  body: string;
  iv?: string;
  tag?: string;
}

type IdempotencyRecord = LockRecord | DoneRecord;

/** What claiming a key found. */
export type Claim =
  /** The key is this request's: run the handler, then `complete` or `release`. */
  | { kind: 'claimed' }
  /** The key holds this request's response: send it again. */
  | { kind: 'replay'; response: StoredResponse }
  /** The key belongs to a different request (another fingerprint). */
  | { kind: 'conflict' }
  /** The same request is still running after the wait. */
  | { kind: 'in_flight' };

/** Why a response was not stored. */
export type NotStoredReason = 'server_error' | 'too_large' | 'unsupported_body';

/** Options for `createIdempotencyStore`. */
export interface IdempotencyStoreOptions {
  kv: KeyValue;
  /** Milliseconds, for `at` in records; default Date.now. Key TTLs follow the KeyValue's clock. */
  clock?: () => number;
  /** Seals the bodies of sensitive responses. */
  encryptionKey?: Secret<Uint8Array>;
  /** How long a duplicate waits for an in-flight request; default IN_FLIGHT_WAIT_MS. */
  inFlightWaitMs?: number;
  /** A monotonic clock for that wait; default performance.now. */
  monotonic?: () => number;
  /** Waits between polls; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Writes `idempotency.invalid_record`. */
  logger?: Logger;
  /** Receives `idempotency_invalid_records_total`. */
  metrics?: Metrics;
}

/** Claims, completes and releases idempotency keys. */
export interface IdempotencyStore {
  /**
   * Claims `storeKey` for a request with fingerprint `fp`, or finds what holds it. A duplicate of
   * an in-flight request waits up to `inFlightWaitMs` for its result. Throws when the KeyValue
   * fails.
   */
  claim(storeKey: string, fp: string): Promise<Claim>;
  /**
   * Keeps `response` for RECORD_TTL_MS, sealed when `sensitive`. Returns why it was not kept
   * (the lock is released then), or undefined once kept. Throws when the KeyValue fails.
   */
  complete(
    storeKey: string,
    fp: string,
    response: StoredResponse,
    options?: { sensitive?: boolean; maxBytes?: number },
  ): Promise<NotStoredReason | undefined>;
  /** Deletes the lock, so a retry runs again. Throws when the KeyValue fails. */
  release(storeKey: string): Promise<void>;
}

/**
 * The store key of an Idempotency-Key: `idem:<sha256>` over the JSON of the principal (null when
 * anonymous), the method, the route template and the key, so one caller's key never meets another
 * caller's, and no choice of values can make two different scopes encode alike.
 */
export function storeKeyFor(
  principal: string | null,
  method: string,
  route: string,
  key: string,
): string {
  const scope = JSON.stringify([principal, method.toUpperCase(), route, key]);
  return `idem:${createHash('sha256').update(scope, 'utf8').digest('hex')}`;
}

const isRecord = (value: unknown): value is IdempotencyRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['fp'] !== 'string' || typeof r['at'] !== 'number') return false;
  if (r['state'] === 'running') return true;
  const headers = r['headers'];
  return (
    r['state'] === 'done' &&
    Number.isInteger(r['status']) &&
    typeof headers === 'object' &&
    headers !== null &&
    Object.values(headers).every((h) => typeof h === 'string') &&
    ['utf8', 'base64', 'aes-256-gcm'].includes(r['enc'] as string) &&
    typeof r['body'] === 'string'
  );
};

/** Polls start quickly and slow down to this. */
const MAX_POLL_MS = 500;

/** A store over `kv`. */
export function createIdempotencyStore(options: IdempotencyStoreOptions): IdempotencyStore {
  const { kv, encryptionKey, logger } = options;
  const clock = options.clock ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
  const waitMs = options.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS;
  const invalid = (options.metrics ?? noopMetrics).counter('idempotency_invalid_records_total');

  /** The response a done record holds; throws when it cannot be read or verified. */
  const responseOf = (record: DoneRecord, storeKey: string): StoredResponse => {
    let body: Buffer;
    if (record.enc === 'aes-256-gcm') {
      if (encryptionKey === undefined || record.iv === undefined || record.tag === undefined) {
        throw new Error('sealed record without a key to open it');
      }
      body = openBody(
        encryptionKey,
        { iv: record.iv, tag: record.tag, data: record.body },
        storeKey,
      );
    } else {
      body = Buffer.from(record.body, record.enc);
    }
    return { status: record.status, headers: record.headers, body };
  };

  /** Parses a stored value; an unreadable one is deleted, counted and logged, then undefined. */
  const readRecord = async (
    storeKey: string,
    raw: string,
  ): Promise<{ record: IdempotencyRecord; response?: StoredResponse } | undefined> => {
    try {
      const record: unknown = JSON.parse(raw);
      if (!isRecord(record)) throw new Error('not an idempotency record');
      return record.state === 'done'
        ? { record, response: responseOf(record, storeKey) }
        : { record };
    } catch {
      // A record that does not parse or verify is never replayed: it counts as lost, like an
      // evicted key, and the request runs as new.
      invalid.inc();
      logger?.error({}, 'idempotency.invalid_record');
      await kv.del(storeKey);
      return undefined;
    }
  };

  const lock = (fp: string): string =>
    JSON.stringify({ v: 1, state: 'running', fp, at: clock() } satisfies LockRecord);

  return {
    async claim(storeKey, fp) {
      const deadline = monotonic() + waitMs;
      for (let attempt = 0; ; attempt++) {
        if (await kv.setIfAbsent(storeKey, lock(fp), LOCK_TTL_MS)) return { kind: 'claimed' };
        const raw = await kv.get(storeKey);
        const found = raw === null ? undefined : await readRecord(storeKey, raw);
        if (found !== undefined) {
          if (!fingerprintsEqual(found.record.fp, fp)) return { kind: 'conflict' };
          if (found.response !== undefined) return { kind: 'replay', response: found.response };
        }
        // Running (or just released): wait for its result, up to the deadline.
        if (monotonic() >= deadline) return { kind: 'in_flight' };
        if (found !== undefined) await sleep(Math.min(MAX_POLL_MS, 20 * 1.5 ** attempt));
      }
    },

    async complete(storeKey, fp, response, opts = {}) {
      const maxBytes = opts.maxBytes ?? DEFAULT_MAX_STORED_BYTES;
      let reason: NotStoredReason | undefined;
      let value: string | undefined;
      if (response.status >= 500) reason = 'server_error';
      else if (response.body.length > maxBytes) reason = 'too_large';
      else {
        const headers: Record<string, string> = {};
        for (const name of STORED_HEADERS) {
          const header = response.headers[name];
          if (header !== undefined) headers[name] = header;
        }
        const base = {
          v: 1,
          state: 'done',
          fp,
          at: clock(),
          status: response.status,
          headers,
        } as const;
        let record: DoneRecord;
        if (opts.sensitive === true) {
          if (encryptionKey === undefined) throw new TypeError('sensitive responses need a key');
          const sealed = sealBody(encryptionKey, response.body, storeKey);
          record = {
            ...base,
            enc: 'aes-256-gcm',
            body: sealed.data,
            iv: sealed.iv,
            tag: sealed.tag,
          };
        } else {
          // JSON and other text is kept as text; anything that is not valid UTF-8, as base64.
          const text = response.body.toString('utf8');
          const utf8 = Buffer.from(text, 'utf8').equals(response.body);
          record = {
            ...base,
            enc: utf8 ? 'utf8' : 'base64',
            body: utf8 ? text : response.body.toString('base64'),
          };
        }
        value = JSON.stringify(record);
        // The record must fit B009's value limit as well as the route's.
        if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) reason = 'too_large';
      }
      if (reason !== undefined || value === undefined) {
        await kv.del(storeKey);
        return reason ?? 'unsupported_body';
      }
      await kv.set(storeKey, value, { ttlMs: RECORD_TTL_MS });
      return undefined;
    },

    async release(storeKey) {
      await kv.del(storeKey);
    },
  };
}
