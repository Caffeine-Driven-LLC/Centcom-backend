/**
 * The API's signing keys, for relay tickets (B038, CT-AUTH "Tokens"): fetched from
 * `RELAY_JWKS_URL`, kept 10 minutes, then refetched. A ticket whose `kid` is unknown triggers a
 * refetch at most once per 30 seconds (a new key appears after a rotation); concurrent lookups share
 * one fetch, so 100 tickets with a new `kid` cost one request. When the API cannot be reached, the
 * keys it last gave keep working for an hour after that fetch; past that, lookups fail with a 503
 * (new handshakes close 4503; open connections are not affected).
 *
 * Only Ed25519 (`OKP`/`Ed25519`) keys are taken; others in the set are ignored.
 *
 * Owns: the cache. Must not: take keys from anywhere but RELAY_JWKS_URL (never a ticket's own `jwk`
 * or `jku`), or fetch without a time limit.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { unavailable } from '@centcom/core';

/** Keys are refetched after this long. */
export const JWKS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches at most this often. */
export const JWKS_COOLDOWN_MS = 30_000;
/** Keys older than this are no longer used when the API cannot be reached. */
export const JWKS_MAX_STALE_MS = 60 * 60_000;
/** A JWKS fetch is abandoned after this long. */
export const JWKS_FETCH_TIMEOUT_MS = 2_000;
/** Most keys taken from one set. */
export const JWKS_MAX_KEYS = 20;

/** Fetches the JWKS document (parsed JSON); rejects on a network error, a timeout or a bad status. */
export type JwksFetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

/** The default fetcher: `fetch`, 200 only, JSON body. */
export const httpJwksFetcher: JwksFetcher = async (url, signal) => {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`JWKS fetch answered ${res.status}`);
  return res.json();
};

/** A JWKS lookup that found no key for the `kid` (after any refetch it was allowed). */
export class UnknownKidError extends Error {
  override name = 'UnknownKidError';
}

/** Options for JwksCache. */
export interface JwksCacheOptions {
  url: string;
  fetch?: JwksFetcher;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Ed25519 public keys of a JWKS document, by `kid`. */
export function parseJwks(doc: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = isRecord(doc) && Array.isArray(doc['keys']) ? doc['keys'] : [];
  for (const jwk of list.slice(0, JWKS_MAX_KEYS)) {
    if (!isRecord(jwk)) continue;
    const { kty, crv, kid, x } = jwk;
    if (kty !== 'OKP' || crv !== 'Ed25519' || typeof kid !== 'string' || typeof x !== 'string') {
      continue;
    }
    try {
      keys.set(kid, createPublicKey({ key: { kty, crv, x }, format: 'jwk' }));
    } catch {
      // A malformed key is skipped; the others still verify.
    }
  }
  return keys;
}

/** The cached key set. */
export class JwksCache {
  readonly #url: string;
  readonly #fetch: JwksFetcher;
  readonly #clock: () => number;
  #keys = new Map<string, KeyObject>();
  /** When the keys were last fetched successfully; null before the first success. */
  #fetchedAt: number | null = null;
  /** When the last fetch started (success or not). */
  #attemptedAt: number | null = null;
  #inflight: Promise<void> | null = null;
  /** Fetches started, for tests and metrics. */
  fetches = 0;

  constructor(options: JwksCacheOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch ?? httpJwksFetcher;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * The public key for `kid`. Rejects with UnknownKidError when the set has none (even after the
   * refetch it was allowed), or a 503 AppError when no usable keys can be had.
   */
  async key(kid: string): Promise<KeyObject> {
    const now = this.#clock();
    const fresh = this.#fetchedAt !== null && now - this.#fetchedAt < JWKS_TTL_MS;
    const coolingDown = this.#attemptedAt !== null && now - this.#attemptedAt < JWKS_COOLDOWN_MS;
    if (this.#inflight !== null) await this.#inflight;
    else if (!coolingDown && (!fresh || !this.#keys.has(kid))) await this.#refresh();
    const usable = this.#fetchedAt !== null && this.#clock() - this.#fetchedAt < JWKS_MAX_STALE_MS;
    if (!usable) {
      throw unavailable(undefined, 'Ticket keys are not available; try again shortly.', {
        cause: new Error('JWKS unavailable'),
      });
    }
    const key = this.#keys.get(kid);
    if (key === undefined) throw new UnknownKidError('no key for the ticket');
    return key;
  }

  /** Fetches the set once, however many callers wait; a failure keeps the old keys. */
  #refresh(): Promise<void> {
    if (this.#inflight !== null) return this.#inflight;
    this.#attemptedAt = this.#clock();
    this.fetches += 1;
    this.#inflight = this.#fetch(this.#url, AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS))
      .then(
        (doc) => {
          const keys = parseJwks(doc);
          if (keys.size === 0) return;
          this.#keys = keys;
          this.#fetchedAt = this.#clock();
        },
        () => undefined,
      )
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }
}
