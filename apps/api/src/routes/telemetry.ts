/**
 * `POST /v1/telemetry/events` (B085, CT-TELEMETRY): opt-in telemetry batches, anonymous or not.
 * The answer is always `204` with an empty body (CT-TELEMETRY rule 4): for a valid batch, invalid
 * JSON, a body over 64 KiB, too many events, unknown types, a wrong content type, no credential or
 * a bad one, a rate limit, or an internal failure. No validation detail and no `Retry-After` ever
 * goes back.
 *
 * - The route reads no credential (`config.auth: false`): stored telemetry cannot be linked to an
 *   account, and the same batch is stored the same way with or without a token.
 * - It parses the body itself (any content type, as bytes, at most the parse limit), so the
 *   framework's own 400/413/415 never answer; its own error handler turns any error into 204.
 * - The client address (`clientIp`) is used for the rate limit only, hashed, never stored.
 *
 * Register it with the global rate limiter's exempt routes (`TELEMETRY_ROUTE`): that limiter
 * answers 429, and telemetry has its own limits that answer 204. Owns: the HTTP side. Must not:
 * answer anything but 204, or read the principal.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { TelemetryIngest } from '../modules/telemetry/service.js';

/** The route template (for the rate limiter's exempt list). */
export const TELEMETRY_ROUTE = '/v1/telemetry/events';
/**
 * The most bytes read from a body. Larger bodies are cut off by the framework and still answered
 * 204; bodies between TELEMETRY_BATCH_MAX_BYTES and this are read and dropped as too large.
 */
export const TELEMETRY_PARSE_LIMIT = 1024 * 1024;

/** Options for `telemetryRoutes`. */
export interface TelemetryRouteOptions {
  ingest: Pick<TelemetryIngest, 'ingest'>;
  /** The client address (B023's `resolveClientIp` with the trusted hops); default the socket's. */
  clientIp?(request: FastifyRequest): string;
}

export const telemetryRoutes: FastifyPluginAsync<TelemetryRouteOptions> = async (app, opts) => {
  const clientIp = opts.clientIp ?? ((request: FastifyRequest) => request.ip);

  // In this plugin only: every body as bytes, whatever its type, and 204 for any error.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: TELEMETRY_PARSE_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler(async (_error, _request, reply) => {
    await reply.code(204).send();
  });

  app.post(
    TELEMETRY_ROUTE,
    { config: { auth: false }, bodyLimit: TELEMETRY_PARSE_LIMIT },
    async (request, reply) => {
      await opts.ingest.ingest({
        body: Buffer.isBuffer(request.body) ? request.body : undefined,
        contentType: request.headers['content-type'],
        ip: clientIp(request),
      });
      return reply.code(204).send();
    },
  );
};
