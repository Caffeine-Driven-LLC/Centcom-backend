/**
 * Idempotency plugin (B024, CT-PAGE): POST routes that declare `config.idempotency` accept an
 * `Idempotency-Key` (`accepted`) or need one (`required`; without it, 400
 * `idempotency_key_required` before any handler runs).
 *
 * - The first request with a key runs; its response (2xx and 4xx, never 5xx) is kept for 24 hours.
 * - The same key with the same request (method, route, path params, body) replays that response
 *   with `Idempotency-Replayed: true`; the handler does not run again.
 * - The same key with a different request: 409 `idempotency_conflict`.
 * - A duplicate of a request that is still running waits up to 10 s for its result, then gets
 *   409 `conflict` with `Retry-After: 1`.
 *
 * Keys are scoped by principal, method and route template. When the KeyValue fails, `required`
 * routes answer 503 (they never run unprotected) and `accepted` routes run without the guarantee.
 *
 * Owns: the hooks, the route-config checks and the failure policy. Must not: run a `required`
 * route unprotected, replay a response to another principal, or keep secret-bearing headers.
 */
import {
  AppError,
  createIdempotencyStore,
  fingerprintRequest,
  IDEMPOTENCY_DETAILS,
  MAX_STORED_BYTES,
  noopMetrics,
  parseIdempotencyKey,
  storeKeyFor,
  unavailable,
  type KeyValue,
  type Logger,
  type Metrics,
  type NotStoredReason,
  type Secret,
  type StoredResponse,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How a POST route uses `Idempotency-Key` (B024): `required` or `accepted`. */
    idempotency?: 'required' | 'accepted';
    /** Keep the stored body encrypted: the response carries a secret (an API key, ...). */
    sensitiveResponse?: boolean;
    /** The largest body kept for replay, in bytes; default 256 KiB, at most 1 MiB. */
    maxStoredBytes?: number;
  }
}

/** Options for `idempotencyPlugin`. */
export interface IdempotencyPluginOptions {
  /** Where records live (B009 `RedisBackend.kv`). */
  kv: KeyValue;
  /** Milliseconds, for the records' timestamps and the warning interval; default Date.now. */
  clock?: () => number;
  /** Encrypts stored bodies of `sensitiveResponse` routes; such routes refuse to start without it. */
  encryptionKey?: Secret<Uint8Array>;
  /**
   * The caller's id (`usr_…`, `key_…`), or null when anonymous: keys are scoped by it (the auth
   * plugin's principal, once B017 is in). Required, so a missing wiring cannot share keys.
   */
  principal: (request: FastifyRequest) => string | null;
  /** How long a duplicate waits for an in-flight request; default 10 s (CT-PAGE). */
  inFlightWaitMs?: number;
  /** Writes `idempotency.unprotected` and `idempotency.store_failed`. */
  logger?: Logger;
  /**
   * Receives `idempotency_replays_total`, `idempotency_conflicts_total{reason}`,
   * `idempotency_not_stored_total{reason}`, `idempotency_unprotected_total` and
   * `idempotency_store_errors_total`.
   */
  metrics?: Metrics;
}

/** At most one `idempotency.unprotected` warning per this many milliseconds. */
export const UNPROTECTED_WARNING_INTERVAL_MS = 60_000;

/** A request that holds its key until its response is kept or released. */
interface Holder {
  storeKey: string;
  fp: string;
  settled: boolean;
}

/** Throws a TypeError for route options the plugin cannot honour. */
function checkRoute(
  route: { url: string; method: string | string[]; config?: Record<string, unknown> },
  hasKey: boolean,
): void {
  const { idempotency, sensitiveResponse, maxStoredBytes } = route.config ?? {};
  if (idempotency === undefined) return;
  const where = `idempotencyPlugin: route ${route.url}`;
  if (idempotency !== 'required' && idempotency !== 'accepted') {
    throw new TypeError(`${where}: config.idempotency must be required or accepted`);
  }
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  if (!methods.includes('POST')) throw new TypeError(`${where}: idempotency applies to POST only`);
  if (sensitiveResponse !== undefined && typeof sensitiveResponse !== 'boolean') {
    throw new TypeError(`${where}: config.sensitiveResponse must be a boolean`);
  }
  if (sensitiveResponse === true && !hasKey) {
    throw new TypeError(`${where}: sensitiveResponse needs an encryptionKey`);
  }
  if (
    maxStoredBytes !== undefined &&
    (!Number.isSafeInteger(maxStoredBytes) ||
      (maxStoredBytes as number) < 1 ||
      (maxStoredBytes as number) > MAX_STORED_BYTES)
  ) {
    throw new TypeError(`${where}: config.maxStoredBytes must be 1 to ${MAX_STORED_BYTES}`);
  }
}

/** The headers of a response, as strings, for the store to pick from. */
function headersOf(reply: FastifyReply): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined)
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

/** Sends a stored response again. */
function replay(reply: FastifyReply, response: StoredResponse): FastifyReply {
  void reply.code(response.status);
  for (const [name, value] of Object.entries(response.headers)) void reply.header(name, value);
  void reply.header('idempotency-replayed', 'true');
  return reply.send(response.body);
}

const plugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (app, options) => {
  const { logger } = options;
  const clock = options.clock ?? Date.now;
  const metrics = options.metrics ?? noopMetrics;
  const store = createIdempotencyStore({
    kv: options.kv,
    clock,
    ...(options.encryptionKey === undefined ? {} : { encryptionKey: options.encryptionKey }),
    ...(options.inFlightWaitMs === undefined ? {} : { inFlightWaitMs: options.inFlightWaitMs }),
    ...(logger === undefined ? {} : { logger }),
    metrics,
  });
  const holders = new WeakMap<FastifyRequest, Holder>();
  let warnedAt = Number.NEGATIVE_INFINITY;

  const notStored = (reason: NotStoredReason): void =>
    metrics.counter('idempotency_not_stored_total', { reason }).inc();

  // Route options the plugin cannot honour fail at startup, not on a request.
  app.addHook('onRoute', (route) => {
    checkRoute(
      { url: route.url, method: route.method, config: route.config as Record<string, unknown> },
      options.encryptionKey !== undefined,
    );
  });

  // After parsing (the body is part of the fingerprint) and before the handler.
  app.addHook('preHandler', async (request, reply) => {
    const mode = request.routeOptions.config.idempotency;
    if (mode === undefined || request.method !== 'POST') return;
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    if (key === undefined) {
      if (mode === 'accepted') return;
      throw new AppError('idempotency_key_required', { detail: IDEMPOTENCY_DETAILS.keyRequired });
    }
    const route = request.routeOptions.url ?? '';
    const storeKey = storeKeyFor(options.principal(request), 'POST', route, key);
    const fp = fingerprintRequest('POST', route, request.params as object, request.body);
    let claim: Awaited<ReturnType<typeof store.claim>>;
    try {
      claim = await store.claim(storeKey, fp);
    } catch {
      // The KeyValue failed. A required key is a promise not to run twice: keep it by not running.
      if (mode === 'required') throw unavailable(1, IDEMPOTENCY_DETAILS.unavailable);
      metrics.counter('idempotency_unprotected_total').inc();
      const now = clock();
      if (now - warnedAt >= UNPROTECTED_WARNING_INTERVAL_MS) {
        warnedAt = now;
        logger?.warn({ route }, 'idempotency.unprotected');
      }
      return;
    }
    switch (claim.kind) {
      case 'claimed':
        holders.set(request, { storeKey, fp, settled: false });
        return;
      case 'replay':
        metrics.counter('idempotency_replays_total').inc();
        return replay(reply, claim.response);
      case 'conflict':
        metrics.counter('idempotency_conflicts_total', { reason: 'fingerprint' }).inc();
        throw new AppError('idempotency_conflict', { detail: IDEMPOTENCY_DETAILS.conflict });
      case 'in_flight':
        metrics.counter('idempotency_conflicts_total', { reason: 'in_flight' }).inc();
        void reply.header('retry-after', '1');
        throw new AppError('conflict', { detail: IDEMPOTENCY_DETAILS.inFlight });
    }
  });

  // Keeps the response (or frees the key) before it goes out, so a quick retry finds it.
  app.addHook('onSend', async (request, reply, payload) => {
    const holder = holders.get(request);
    if (holder === undefined || holder.settled) return payload;
    holder.settled = true;
    const config = request.routeOptions.config;
    const body =
      typeof payload === 'string'
        ? Buffer.from(payload, 'utf8')
        : Buffer.isBuffer(payload)
          ? payload
          : payload === null || payload === undefined
            ? Buffer.alloc(0)
            : undefined;
    try {
      if (body === undefined) {
        // A stream cannot be kept: the key is freed and a retry runs again.
        await store.release(holder.storeKey);
        notStored('unsupported_body');
        return payload;
      }
      const response = { status: reply.statusCode, headers: headersOf(reply), body };
      const reason = await store.complete(holder.storeKey, holder.fp, response, {
        sensitive: config.sensitiveResponse === true,
        ...(config.maxStoredBytes === undefined ? {} : { maxBytes: config.maxStoredBytes }),
      });
      if (reason !== undefined) notStored(reason);
    } catch {
      // The response still goes out; the lock expires on its own (LOCK_TTL_MS).
      metrics.counter('idempotency_store_errors_total').inc();
      logger?.error({ route: request.routeOptions.url }, 'idempotency.store_failed');
    }
    return payload;
  });

  // A response that never passed onSend (a hijacked reply) frees its key.
  app.addHook('onResponse', async (request) => {
    const holder = holders.get(request);
    if (holder === undefined || holder.settled) return;
    holder.settled = true;
    await store.release(holder.storeKey).catch(() => {
      metrics.counter('idempotency_store_errors_total').inc();
    });
  });
};

/**
 * Applies to the whole instance (like the error handler). Register it after the request context,
 * error handler and auth plugins (it reads the principal), before any route.
 */
export const idempotencyPlugin: FastifyPluginAsync<IdempotencyPluginOptions> = Object.assign(
  plugin,
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'centcom-idempotency',
  },
);
