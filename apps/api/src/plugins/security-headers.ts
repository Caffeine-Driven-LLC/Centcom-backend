/**
 * Security headers and CORS (B097): every reply of the API (200, 304, 4xx, 5xx and CORS
 * preflights) carries the same hardening headers, and browsers get cross-origin access only from
 * the configured web origins.
 *
 * - Headers: HSTS, a CSP that allows nothing, `nosniff`, `Referrer-Policy: no-referrer`,
 *   `Cross-Origin-Resource-Policy: same-site` and a Permissions-Policy with every feature off. A
 *   route that already set one of them (the device page sets its own CSP) keeps its value, which
 *   is why a route can only ever make a header stricter or document an exception
 *   (docs/security/hardening.md lists them; a test pins the list).
 * - `Cache-Control: no-store` is forced on `/v1/auth/*` and the billing routes, and is the default
 *   for any other `/v1/*` reply that sets no Cache-Control of its own.
 * - CORS: only origins in `allowedOrigins`, compared as exact strings, and answered with that exact
 *   origin (never `*`, never a reflected value) and `Vary: Origin`. Credentials are allowed only on
 *   `/v1/auth/token` (the web client's refresh cookie; the route itself requires
 *   `X-Centcom-Client: web`). A preflight is answered here with 204 and `Access-Control-Max-Age: 600`.
 *
 * Owns: the headers and the preflight answer. Must not: reflect an unlisted origin, allow a
 * wildcard, or add credentials anywhere but the token endpoint. Register it first, so preflights
 * are answered before the rate limiter counts them.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/** The token endpoint, the only path whose CORS answers allow credentials. */
export const CREDENTIALED_PATH = '/v1/auth/token';
/** Seconds a browser may cache a preflight answer. */
export const PREFLIGHT_MAX_AGE_S = 600;

/** Headers every reply gets unless the route set its own. */
export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
});

/** Methods and request headers a cross-origin caller may use. */
export const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
export const CORS_ALLOWED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'x-centcom-client',
  'x-request-id',
].join(', ');
/** Response headers a browser script may read. */
export const CORS_EXPOSED_HEADERS = [
  'etag',
  'idempotency-replayed',
  'location',
  'retry-after',
  'x-request-id',
].join(', ');

/** Paths where `Cache-Control: no-store` replaces whatever the route set. */
const ALWAYS_NO_STORE = [
  /^\/v1\/auth(\/|$)/,
  /^\/v1\/(billing_portal|checkout|invoices)(\/|$)/,
  /^\/v1\/workspaces\/[^/]+\/(checkout|portal|subscription|invoices|seats|coupons)(\/|$)/,
];

/** Options for `securityHeadersPlugin`. */
export interface SecurityHeadersOptions {
  /** Exact origins (`https://app.example.com`) allowed to call the API from a browser. */
  allowedOrigins: Iterable<string>;
}

const pathOf = (request: FastifyRequest): string => {
  const url = request.url;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
};

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Adds `Origin` to `Vary` without dropping what is there. */
function addVaryOrigin(reply: FastifyReply): void {
  const current = reply.getHeader('vary');
  const text = Array.isArray(current) ? current.join(', ') : String(current ?? '');
  if (text.trim() === '*') return;
  if (!text.split(',').some((v) => v.trim().toLowerCase() === 'origin')) {
    void reply.header('vary', text === '' ? 'Origin' : `${text}, Origin`);
  }
}

const plugin: FastifyPluginAsync<SecurityHeadersOptions> = async (app, opts) => {
  const allowed = new Set(opts.allowedOrigins);
  const preflights = new WeakSet<FastifyReply>();

  /** The exact allowed origin of a request, or undefined. */
  const allowedOrigin = (request: FastifyRequest): string | undefined => {
    const origin = single(request.headers.origin);
    return origin !== undefined && allowed.has(origin) ? origin : undefined;
  };

  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'OPTIONS') return;
    const origin = single(request.headers.origin);
    const wanted = single(request.headers['access-control-request-method']);
    if (origin === undefined || wanted === undefined) return; // not a preflight
    preflights.add(reply);
    void reply.code(204);
    if (allowedOrigin(request) !== undefined) {
      void reply
        .header('access-control-allow-methods', CORS_METHODS)
        .header('access-control-allow-headers', CORS_ALLOWED_HEADERS)
        .header('access-control-max-age', String(PREFLIGHT_MAX_AGE_S));
    }
    return reply.send();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(BASE_HEADERS)) {
      if (reply.getHeader(name) === undefined) void reply.header(name, value);
    }

    const path = pathOf(request);
    if (!preflights.has(reply)) {
      if (ALWAYS_NO_STORE.some((re) => re.test(path))) {
        void reply.header('cache-control', 'no-store');
      } else if (path.startsWith('/v1/') && reply.getHeader('cache-control') === undefined) {
        void reply.header('cache-control', 'no-store');
      }
    }

    if (single(request.headers.origin) !== undefined) {
      addVaryOrigin(reply);
      const origin = allowedOrigin(request);
      if (origin !== undefined) {
        void reply.header('access-control-allow-origin', origin);
        if (!preflights.has(reply)) {
          void reply.header('access-control-expose-headers', CORS_EXPOSED_HEADERS);
        }
        if (path === CREDENTIALED_PATH)
          void reply.header('access-control-allow-credentials', 'true');
      }
    }
    return payload;
  });
};

/** Registers the hooks on the whole instance. Register it first, before other plugins and routes. */
export const securityHeadersPlugin: FastifyPluginAsync<SecurityHeadersOptions> = Object.assign(
  plugin,
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'centcom-security-headers',
  },
);
