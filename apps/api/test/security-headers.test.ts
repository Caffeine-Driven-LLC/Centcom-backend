/**
 * Security headers and CORS (B097): a table over 15 representative replies (success, 304, client
 * and server errors, the device page, a preflight) asserts exact header values; CORS answers only
 * the configured origins, with the exact origin and `Vary: Origin`, and credentials only on the
 * token endpoint; the documented exception list is pinned.
 */
import { badRequest, createLogger, unauthorized } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import {
  BASE_HEADERS,
  CORS_ALLOWED_HEADERS,
  CORS_METHODS,
  PREFLIGHT_MAX_AGE_S,
  securityHeadersPlugin,
} from '../src/plugins/security-headers.js';

const WEB = 'https://app.centcom.dev';
const EVIL = 'https://evil.example';
const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** Routes that are allowed to differ from BASE_HEADERS, with the reason; the test pins this list. */
const EXCEPTIONS = [
  {
    route: '/device',
    header: 'content-security-policy',
    reason: 'HTML form needs inline style and form-action',
  },
] as const;

async function build(): Promise<FastifyInstance> {
  const logger = createLogger({
    level: 'silent',
    service: 'api',
    version: 'test',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const app = fastify();
  await app.register(securityHeadersPlugin, { allowedOrigins: [WEB] });
  await app.register(requestContextPlugin, { logger });
  await app.register(errorHandlerPlugin, { logger });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ok' }));
  app.get('/v1/status', async () => ({ status: 'ok' }));
  app.get('/.well-known/jwks.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send({ keys: [] }),
  );
  app.get('/v1/me', async () => ({ user: 'usr_x' }));
  app.post('/v1/auth/token', async () => ({ access_token: 'x' }));
  app.get('/v1/auth/devices', async () => ({ devices: [] }));
  app.get('/v1/workspaces/:id/subscription', async () => ({ plan: 'pro' }));
  app.get('/v1/invoices', async () => ({ data: [] }));
  app.get('/v1/plans', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=60').send({ plans: [] }),
  );
  app.get('/v1/cached', async (_req, reply) => reply.code(304).send());
  app.get('/v1/private-ok', async (_req, reply) =>
    reply.header('cache-control', 'private, no-cache').send({ ok: true }),
  );
  app.get('/v1/denied', async () => {
    throw unauthorized();
  });
  app.get('/v1/invalid', async () => {
    throw badRequest();
  });
  app.get('/v1/boom', async () => {
    throw new Error('boom');
  });
  app.get('/device', async (_req, reply) =>
    reply
      .type('text/html')
      .header('content-security-policy', HTML_CSP)
      .header('cache-control', 'no-store')
      .send('<p>hi</p>'),
  );
  return app;
}

interface Row {
  name: string;
  method: 'GET' | 'POST' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  status: number;
  /** Header overrides of BASE_HEADERS. */
  expect?: Record<string, string>;
  cacheControl?: string | undefined;
}

const ROWS: Row[] = [
  { name: 'healthz', method: 'GET', url: '/healthz', status: 200 },
  { name: 'readyz', method: 'GET', url: '/readyz', status: 200 },
  {
    name: 'status (v1, no cache header of its own)',
    method: 'GET',
    url: '/v1/status',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'jwks keeps its public cache header',
    method: 'GET',
    url: '/.well-known/jwks.json',
    status: 200,
    cacheControl: 'public, max-age=300',
  },
  {
    name: 'authenticated JSON',
    method: 'GET',
    url: '/v1/me',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'token endpoint',
    method: 'POST',
    url: '/v1/auth/token',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'auth devices',
    method: 'GET',
    url: '/v1/auth/devices',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'subscription (billing)',
    method: 'GET',
    url: '/v1/workspaces/wsp_1/subscription',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'invoices (billing)',
    method: 'GET',
    url: '/v1/invoices',
    status: 200,
    cacheControl: 'no-store',
  },
  {
    name: 'a public route may cache, outside the forced paths',
    method: 'GET',
    url: '/v1/plans',
    status: 200,
    cacheControl: 'public, max-age=60',
  },
  { name: '304', method: 'GET', url: '/v1/cached', status: 304, cacheControl: 'no-store' },
  { name: '401', method: 'GET', url: '/v1/denied', status: 401, cacheControl: 'no-store' },
  { name: '400', method: 'GET', url: '/v1/invalid', status: 400, cacheControl: 'no-store' },
  { name: '500', method: 'GET', url: '/v1/boom', status: 500, cacheControl: 'no-store' },
  { name: '404', method: 'GET', url: '/v1/nothing-here', status: 404, cacheControl: 'no-store' },
  { name: '405', method: 'POST', url: '/v1/me', status: 405, cacheControl: 'no-store' },
  {
    name: 'preflight',
    method: 'OPTIONS',
    url: '/v1/me',
    headers: { origin: WEB, 'access-control-request-method': 'GET' },
    status: 204,
  },
  {
    name: 'HTML page keeps its own CSP (documented exception)',
    method: 'GET',
    url: '/device',
    status: 200,
    expect: { 'content-security-policy': HTML_CSP },
    cacheControl: 'no-store',
  },
];

describe('security headers', () => {
  it.each(ROWS)('$name', async (row) => {
    const app = await build();
    const res = await app.inject({
      method: row.method,
      url: row.url,
      ...(row.headers === undefined ? {} : { headers: row.headers }),
    });
    expect(res.statusCode).toBe(row.status);
    for (const [name, value] of Object.entries({ ...BASE_HEADERS, ...row.expect })) {
      expect(res.headers[name], name).toBe(value);
    }
    if (row.cacheControl !== undefined) expect(res.headers['cache-control']).toBe(row.cacheControl);
    if (row.name === 'healthz') expect(res.headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('has the headers the card lists, with these exact values', () => {
    expect(BASE_HEADERS['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(BASE_HEADERS['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(BASE_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(BASE_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(BASE_HEADERS['cross-origin-resource-policy']).toBe('same-site');
    expect(BASE_HEADERS['permissions-policy']).toMatch(/camera=\(\).*microphone=\(\)/);
  });

  it('pins the documented exceptions: only the device page differs from the base headers', async () => {
    expect(EXCEPTIONS.map((e) => e.route)).toEqual(['/device']);
    const app = await build();
    for (const row of ROWS.filter((r) => r.status !== 204)) {
      const res = await app.inject({ method: row.method, url: row.url });
      const differs = Object.entries(BASE_HEADERS).filter(
        ([name, value]) => res.headers[name] !== value,
      );
      expect(
        differs.map(([name]) => name),
        row.url,
      ).toEqual(row.url === '/device' ? ['content-security-policy'] : []);
    }
    await app.close();
  });

  it('always sends no-store on /v1/auth/token, even if the route said otherwise', async () => {
    const app = await build();
    app.get('/v1/auth/odd', async (_req, reply) =>
      reply.header('cache-control', 'public, max-age=60').send({}),
    );
    const res = await app.inject({ method: 'GET', url: '/v1/auth/odd' });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});

describe('CORS', () => {
  it('gives an unlisted origin no Access-Control-Allow-Origin, on a request and on a preflight', async () => {
    const app = await build();
    const actual = await app.inject({ method: 'GET', url: '/v1/me', headers: { origin: EVIL } });
    expect(actual.headers['access-control-allow-origin']).toBeUndefined();
    expect(actual.headers['access-control-allow-credentials']).toBeUndefined();
    expect(actual.headers['vary']).toBe('Origin');
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: EVIL, 'access-control-request-method': 'GET' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.headers['access-control-allow-methods']).toBeUndefined();
    for (const origin of [
      'null',
      `${WEB}.evil.example`,
      'http://app.centcom.dev',
      WEB.toUpperCase(),
    ]) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { origin } });
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    await app.close();
  });

  it('echoes exactly an allowed origin, never *, with Vary: Origin', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['vary']).toBe('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toContain('x-request-id');
    await app.close();
  });

  it('allows credentials only on /v1/auth/token, in the preflight and the reply', async () => {
    const app = await build();
    const token = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { origin: WEB, 'x-centcom-client': 'web' },
    });
    expect(token.headers['access-control-allow-credentials']).toBe('true');
    expect(token.headers['access-control-allow-origin']).toBe(WEB);
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/token',
      headers: {
        origin: WEB,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-centcom-client',
      },
    });
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    const other = await app.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: { origin: WEB },
    });
    expect(other.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('answers an allowed preflight with 204, the method and header lists, and a 600 s cache', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: WEB, 'access-control-request-method': 'PATCH' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-methods']).toBe(CORS_METHODS);
    expect(res.headers['access-control-allow-headers']).toBe(CORS_ALLOWED_HEADERS);
    expect(res.headers['access-control-max-age']).toBe(String(PREFLIGHT_MAX_AGE_S));
    expect(PREFLIGHT_MAX_AGE_S).toBe(600);
    expect(res.body).toBe('');
    await app.close();
  });

  it('keeps an existing Vary value and treats a plain OPTIONS (no Origin) as a normal request', async () => {
    const app = await build();
    app.get('/v1/varies', async (_req, reply) => reply.header('vary', 'Accept-Encoding').send({}));
    const res = await app.inject({ method: 'GET', url: '/v1/varies', headers: { origin: WEB } });
    expect(res.headers['vary']).toBe('Accept-Encoding, Origin');
    const options = await app.inject({ method: 'OPTIONS', url: '/v1/me' });
    expect(options.statusCode).toBe(405);
    expect(options.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('with no allowed origins configured, no origin is ever allowed', async () => {
    const app = fastify();
    await app.register(securityHeadersPlugin, { allowedOrigins: [] });
    app.get('/v1/x', async () => ({}));
    const res = await app.inject({ method: 'GET', url: '/v1/x', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
