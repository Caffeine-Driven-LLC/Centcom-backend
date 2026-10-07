/**
 * Request context plugin (B005): gives every request a CT-IDS `req_` id, echoes it in
 * `X-Request-Id`, runs the request inside the logging context (so every log line carries the id)
 * and writes one access-log line per request.
 *
 * Owns: request id selection, the context's lifetime and the access log. Must not: log headers,
 * bodies, raw URLs or query strings, or use anything but the route template in logs and metric
 * labels.
 */
import { performance } from 'node:perf_hooks';
import { isId, newId } from '@centcom/contracts';
import { noopMetrics, runWithContext, type Logger, type Metrics } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/** The request and response header that carries the request id (CT-ERR rule 4). */
export const REQUEST_ID_HEADER = 'x-request-id';
/** The access log's `route` for a request that matched no route (the 404 handler). */
export const UNMATCHED_ROUTE = '(unmatched)';
/** The access log's `status` for a request the client abandoned before a response was sent. */
export const CLIENT_CLOSED_STATUS = 499;
/** Upper bounds, in seconds, of the `http_request_duration_seconds` buckets. */
export const DURATION_BUCKETS_S: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
]);

/** Options for `requestContextPlugin`. */
export interface RequestContextOptions {
  /** Writes the access log. */
  logger: Logger;
  /** Receives `http_requests_total` and `http_request_duration_seconds`; default no-op. */
  metrics?: Metrics;
  /** Makes an id for a request without a valid one; default `newId('req')`. */
  newRequestId?: () => string;
  /** A monotonic clock in milliseconds, for `duration_ms`; default `performance.now`. */
  clock?: () => number;
}

/**
 * The id a client sent, if it is a valid `req_` id. A repeated header counts by its first value,
 * whether Node joined the repeats with commas or passed them as an array.
 */
export function clientRequestId(header: string | string[] | undefined): string | undefined {
  const first = Array.isArray(header) ? header[0] : header;
  const candidate = first?.split(',', 1)[0]?.trim();
  return isId('req', candidate) ? candidate : undefined;
}

interface RequestState {
  readonly requestId: string;
  readonly start: number;
}

const plugin: FastifyPluginAsync<RequestContextOptions> = async (fastify, options) => {
  const { logger } = options;
  const metrics = options.metrics ?? noopMetrics;
  const newRequestId = options.newRequestId ?? (() => newId('req'));
  const clock = options.clock ?? (() => performance.now());
  const duration = metrics.histogram('http_request_duration_seconds', DURATION_BUCKETS_S);
  const states = new WeakMap<FastifyRequest, RequestState>();

  /** Writes the request's one access-log line; its state goes, so a second call does nothing. */
  const accessLog = (request: FastifyRequest, reply: FastifyReply | undefined): void => {
    const state = states.get(request);
    if (state === undefined) return;
    states.delete(request);
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    const status = reply === undefined ? CLIENT_CLOSED_STATUS : reply.statusCode;
    const durationMs = Math.max(0, clock() - state.start);
    const fields: Record<string, unknown> = {
      request_id: state.requestId,
      method: request.method,
      route,
      status,
      duration_ms: Math.round(durationMs),
    };
    const length = Number(reply?.getHeader('content-length'));
    if (Number.isInteger(length) && length >= 0) fields['bytes'] = length;
    if (reply === undefined) fields['aborted'] = true;
    logger.info(fields, 'http.request');
    const statusClass = `${Math.floor(status / 100)}xx`;
    metrics
      .counter('http_requests_total', { method: request.method, route, status_class: statusClass })
      .inc();
    duration.observe(durationMs / 1000, { method: request.method, route });
  };

  fastify.addHook('onRequest', (request, reply, done) => {
    const requestId = clientRequestId(request.headers[REQUEST_ID_HEADER]) ?? newRequestId();
    // Fastify's own id follows ours, so anything reading request.id (the error handler, B006)
    // reports the same value as the header and the logs.
    request.id = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
    states.set(request, { requestId, start: clock() });
    // Everything after this hook runs inside the context. Fastify carries it across body parsing
    // itself (its content-type parser runner re-enters the request's async scope).
    runWithContext({ requestId }, done);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    accessLog(request, reply);
    done();
  });

  // The client went away before the response: Fastify never fires onResponse for it.
  fastify.addHook('onRequestAbort', (request, done) => {
    accessLog(request, undefined);
    done();
  });
};

/**
 * Registers the request id, context and access-log hooks on the whole Fastify instance (not just
 * the plugin's encapsulation context). Register it first, before routes and other plugins.
 */
export const requestContextPlugin: FastifyPluginAsync<RequestContextOptions> = Object.assign(
  plugin,
  {
    // Fastify's documented alternative to fastify-plugin: apply the hooks to the parent instance.
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'centcom-request-context',
  },
);
