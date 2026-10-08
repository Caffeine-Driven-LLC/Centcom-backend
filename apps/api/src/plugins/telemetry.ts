/**
 * Request tracing (B093): one server span per HTTP request, named by its route template
 * (`GET /v1/users/:id`), never the URL. Its attributes are the method, the route template, the
 * status code and the request's `req_` id (how a trace links to logs); a sampled span's trace id
 * also goes into the request's logging context, so every log line of the request carries
 * `trace_id`. A 5xx marks the span as an error, by the error's code only.
 *
 * Incoming `traceparent` headers are ignored: clients outside Centcom do not choose trace ids.
 * HTTP metrics are recorded by the request context plugin (B005) through the service's metrics
 * (`initTelemetry().metrics`).
 *
 * Register after the request context plugin. Owns: the request span. Must not: put a URL, query,
 * header or body into a span.
 */
import { getRequestContext, sampledTraceId } from '@centcom/core';
import { SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UNMATCHED_ROUTE } from './request-context.js';

/** Options for `telemetryPlugin`. */
export interface TelemetryPluginOptions {
  /** `initTelemetry().tracer`. */
  tracer: Tracer;
}

const plugin: FastifyPluginAsync<TelemetryPluginOptions> = async (fastify, opts) => {
  const spans = new WeakMap<FastifyRequest, Span>();

  // Callback hooks, not async ones: this runs on every request and must stay cheap.
  fastify.addHook('onRequest', (request, _reply, done) => {
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    const span = opts.tracer.startSpan(`${request.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': request.method,
        'http.route': route,
        'centcom.request_id': request.id,
      },
    });
    spans.set(request, span);
    const traceId = sampledTraceId(span);
    if (traceId !== undefined) {
      const context = getRequestContext();
      if (context !== undefined) context.traceId = traceId;
    }
    done();
  });

  fastify.addHook('onError', (request, _reply, error, done) => {
    const span = spans.get(request);
    const code = (error as { code?: unknown }).code;
    span?.setAttribute('error.type', typeof code === 'string' ? code : error.name);
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span !== undefined) {
      spans.delete(request);
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });

  fastify.addHook('onRequestAbort', (request, done) => {
    const span = spans.get(request);
    if (span !== undefined) {
      spans.delete(request);
      span.setAttribute('centcom.aborted', true);
      span.end();
    }
    done();
  });
};

/** The request tracing hooks, on the whole Fastify instance. */
export const telemetryPlugin: FastifyPluginAsync<TelemetryPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-telemetry',
});
