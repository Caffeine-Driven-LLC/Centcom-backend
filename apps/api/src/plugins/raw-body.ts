/**
 * Raw request bodies (B072): in the plugin context it is registered in, every body is kept as the
 * exact bytes received (`request.body` is a Buffer), whatever its content type, up to `bodyLimit`
 * (default 1 MiB; a larger body is 413 before any handler runs). For endpoints that verify a
 * signature over the bytes, such as Stripe's webhook, before parsing anything.
 *
 * Call `useRawBody(app)` inside the route plugin that needs it (or register `rawBodyPlugin` around
 * the routes): it replaces the content-type parsers of that context only, so other routes keep
 * their JSON parsing.
 *
 * Owns: the parser of its context. Must not: parse, log or keep a body.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

/** The default largest body, in bytes (1 MiB). */
export const RAW_BODY_LIMIT = 1_048_576;

/** Options for `rawBodyPlugin`. */
export interface RawBodyOptions {
  /** Default RAW_BODY_LIMIT. */
  bodyLimit?: number;
}

/** Keeps every body of `app`'s context as bytes. */
export function useRawBody(app: FastifyInstance, opts: RawBodyOptions = {}): void {
  const bodyLimit = opts.bodyLimit ?? RAW_BODY_LIMIT;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (_request, body, done) => {
    done(null, body);
  });
}

/** `useRawBody` as a plugin, for routes registered inside it (not wrapped in fastify-plugin). */
export const rawBodyPlugin: FastifyPluginAsync<RawBodyOptions> = async (app, opts) => {
  useRawBody(app, opts);
};

/** The request's body as bytes; an empty Buffer when it has none. */
export function rawBodyOf(request: FastifyRequest): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}
