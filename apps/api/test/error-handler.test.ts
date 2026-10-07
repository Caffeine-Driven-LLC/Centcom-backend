/**
 * Error handler plugin (B006): thrown errors, Fastify's own errors, unmatched routes and errors
 * raised before routing all leave the API as CT-ERR problems (acceptance 1-6), with the guardrails
 * and failure modes of the card. Every problem response is checked against
 * contracts/schemas/problem.schema.json and against its X-Request-Id and Retry-After headers.
 */
import { newId, validate, validateProblem } from '@centcom/contracts';
import {
  AppError,
  badRequest,
  DEFAULT_RETRY_AFTER_S,
  ERROR_CODES,
  ERROR_DETAILS,
  ERROR_TYPE_BASE,
  fallbackProblemBody,
  forbidden,
  isErrorCode,
  notFound,
  tooManyRequests,
  unauthorized,
  unavailable,
  validationFailed,
  type ErrorCode,
  type Problem,
} from '@centcom/core';
import { fastify, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  errorHandlerPlugin,
  frameworkErrorHandler,
  type ErrorHandlerOptions,
} from '../src/plugins/error-handler.js';
import { REQUEST_ID_HEADER, requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger, REQUEST_ID, REQUEST_ID_PATTERN } from './helpers.js';

/** `n` base62 characters. */
const base62 = (n: number): string => 'Ab3k9ZqR7x'.repeat(Math.ceil(n / 10)).slice(0, n);
const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
// Secret-shaped values are assembled at run time, so the repository holds no literal for the
// secret scan (B002) to flag.
const JWT = [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ sub: 'usr_x' }), base62(43)].join(
  '.',
);
const LIVE_KEY = ['cen', 'live', base62(32)].join('_');
const COOKIE_VALUE = `s3ss10n-${base62(24)}`;

type Routes = (app: FastifyInstance) => void;

/**
 * An app as the API runs it: request context first, then the error handler, then the routes;
 * Fastify's own logger off and `frameworkErrors` set.
 */
async function buildApp(
  routes: Routes,
  options: Partial<ErrorHandlerOptions> & { requestContext?: boolean } = {},
): Promise<{ app: FastifyInstance } & ReturnType<typeof captureLogger>> {
  const captured = captureLogger();
  const { requestContext = true, ...handlerOptions } = options;
  const app = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  if (requestContext) await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger, ...handlerOptions });
  routes(app);
  await app.ready();
  return { app, ...captured };
}

/**
 * The response's problem, after checking what every problem response must hold: the media type,
 * the schema, a registry code and its type, the status, the request id echoed in X-Request-Id,
 * and Retry-After exactly when retry_after_s is present.
 */
function problemOf(res: LightMyRequestResponse): Problem {
  expect(res.headers['content-type']).toBe('application/problem+json');
  const body = res.json<Problem>();
  const result = validateProblem(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
  expect(isErrorCode(body.code)).toBe(true);
  expect(body.type).toBe(`${ERROR_TYPE_BASE}${body.code}`);
  expect(body.status).toBe(res.statusCode);
  expect(body.request_id).toMatch(REQUEST_ID_PATTERN);
  expect(body.request_id).toBe(res.headers[REQUEST_ID_HEADER]);
  if (body.retry_after_s === undefined) expect(res.headers['retry-after']).toBeUndefined();
  else expect(res.headers['retry-after']).toBe(String(body.retry_after_s));
  return body;
}

/** The `http.error` log lines. */
const errorLines = (lines: () => Record<string, unknown>[]): Record<string, unknown>[] =>
  lines().filter((line) => line['msg'] === 'http.error');

/** A usage event that satisfies the CT-API-USAGE schema. */
const usageEvent = (qty: number): Record<string, unknown> => ({
  id: newId('use'),
  type: 'agent_minutes',
  qty,
  at: '2026-10-05T18:07:41.123Z',
});

describe('thrown AppErrors (acceptance 1)', () => {
  const routes: Routes = (app) => {
    app.get('/v1/workspaces/:id', async () => {
      throw forbidden();
    });
    app.addHook('preHandler', async (request) => {
      if (request.url.startsWith('/v1/guarded')) throw unauthorized();
    });
    app.get('/v1/guarded', async () => ({ ok: true }));
  };

  it('forbidden() is a 403 application/problem+json whose request_id is the X-Request-Id header', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/workspaces/wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    const problem = problemOf(res);
    expect(problem).toEqual({
      type: 'https://centcom.dev/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      instance: '/v1/workspaces/:id',
      request_id: res.headers[REQUEST_ID_HEADER],
    });
  });

  it("reuses the client's valid X-Request-Id", async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/workspaces/x',
      headers: { [REQUEST_ID_HEADER]: REQUEST_ID },
    });
    expect(problemOf(res).request_id).toBe(REQUEST_ID);
  });

  it('covers errors thrown by hooks before the handler', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/guarded' });
    expect(res.statusCode).toBe(401);
    expect(problemOf(res)).toMatchObject({ code: 'unauthorized', instance: '/v1/guarded' });
  });

  it('logs a client error at debug with the code, route template and status, never the URL', async () => {
    const { app, lines } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/workspaces/wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W?q=private',
    });
    const [line, ...rest] = errorLines(lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'debug',
      request_id: res.headers[REQUEST_ID_HEADER],
      status: 403,
      error_code: 'forbidden',
      method: 'GET',
      route: '/v1/workspaces/:id',
    });
    expect(JSON.stringify(line)).not.toContain('wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W');
    expect(JSON.stringify(line)).not.toContain('private');
  });
});

describe('validation failures (acceptance 2)', () => {
  const routes: Routes = (app) => {
    app.post('/v1/usage/events', async (request) => {
      const result = validate('api/UsageBatch', request.body);
      if (!result.ok) throw validationFailed(result.errors);
      return { accepted: result.value.events.length };
    });
    app.post(
      '/v1/schema',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, n: { type: 'integer', minimum: 0 } },
          },
        },
      },
      async () => ({ ok: true }),
    );
  };

  it('a contract validator failure is a 422 whose errors[0].pointer is a JSON Pointer like /events/3/qty', async () => {
    const { app } = await buildApp(routes);
    const events = [usageEvent(1), usageEvent(2), usageEvent(3), usageEvent(-1)];
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      payload: { events: events.slice(0, 3) },
    });
    expect(ok.json()).toEqual({ accepted: 3 });

    const res = await app.inject({ method: 'POST', url: '/v1/usage/events', payload: { events } });
    expect(res.statusCode).toBe(422);
    const problem = problemOf(res);
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors?.[0]).toEqual({
      pointer: '/events/3/qty',
      code: 'out_of_range',
      detail: 'must be >= 0',
    });
  });

  it('a Fastify route schema failure is mapped the same way, without Ajv messages', async () => {
    const { app } = await buildApp(routes);
    const missing = await app.inject({ method: 'POST', url: '/v1/schema', payload: { n: 1 } });
    expect(missing.statusCode).toBe(422);
    expect(problemOf(missing)).toMatchObject({
      code: 'validation_failed',
      detail: ERROR_DETAILS.schemaMismatch,
      errors: [{ pointer: '/name', code: 'required' }],
    });
    const negative = await app.inject({
      method: 'POST',
      url: '/v1/schema',
      payload: { name: 'x', n: -1 },
    });
    expect(problemOf(negative).errors).toEqual([{ pointer: '/n', code: 'invalid' }]);
  });
});

describe('retry hints (acceptance 3)', () => {
  const routes: Routes = (app) => {
    app.get('/v1/limited', async () => {
      throw tooManyRequests(30);
    });
    app.get('/v1/quota', async () => {
      throw new AppError('quota_exceeded', { retryAfterS: 3600 });
    });
    app.get('/v1/down', async () => {
      throw unavailable(120);
    });
    app.get('/v1/down-default', async () => {
      throw unavailable();
    });
    app.get('/v1/bad', async () => {
      throw new AppError('invalid_request', { retryAfterS: 10 });
    });
    app.get('/v1/denied', async () => {
      throw new AppError('forbidden', { retryAfterS: 10 });
    });
    app.get('/v1/missing', async () => {
      throw new AppError('not_found', { retryAfterS: 10 });
    });
  };

  it('429 and 503 problems carry an integer retry_after_s and a matching Retry-After header', async () => {
    const { app } = await buildApp(routes);
    for (const [url, status, seconds] of [
      ['/v1/limited', 429, 30],
      ['/v1/quota', 429, 3600],
      ['/v1/down', 503, 120],
      ['/v1/down-default', 503, DEFAULT_RETRY_AFTER_S],
    ] as const) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(status);
      const problem = problemOf(res);
      expect(problem.retry_after_s, url).toBe(seconds);
      expect(Number.isInteger(problem.retry_after_s)).toBe(true);
      expect(res.headers['retry-after'], url).toBe(String(seconds));
    }
  });

  it('400, 403 and 404 problems never carry them, even when the error has a hint', async () => {
    const { app } = await buildApp(routes);
    for (const [url, status] of [
      ['/v1/bad', 400],
      ['/v1/denied', 403],
      ['/v1/missing', 404],
      ['/v1/unknown-route', 404],
    ] as const) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(status);
      expect(problemOf(res), url).not.toHaveProperty('retry_after_s');
      expect(res.headers['retry-after'], url).toBeUndefined();
    }
  });
});

describe('unexpected errors (acceptance 4)', () => {
  const SERVER_PATH = '/srv/centcom/apps/api/dist/routes/sessions.js';
  const routes: Routes = (app) => {
    app.get('/v1/sessions/:id', async (request) => {
      throw new TypeError(
        `Cannot read properties of undefined (reading 'host') at ${SERVER_PATH}:12:5 for ${String(request.headers.authorization)}`,
      );
    });
    app.get('/v1/string', async () => {
      throw 'a thrown string';
    });
  };

  it('a TypeError is a 500 with a generic detail and no message, stack or path', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { authorization: `Bearer ${JWT}` },
    });
    expect(res.statusCode).toBe(500);
    const problem = problemOf(res);
    expect(problem).toEqual({
      type: 'https://centcom.dev/errors/internal_error',
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
      detail: ERROR_DETAILS.internal,
      instance: '/v1/sessions/:id',
      request_id: res.headers[REQUEST_ID_HEADER],
      retry_after_s: DEFAULT_RETRY_AFTER_S,
    });
    for (const leak of [
      'Cannot read',
      'TypeError',
      'stack',
      SERVER_PATH,
      'sessions.js',
      ' at ',
      JWT,
    ]) {
      expect(res.payload, leak).not.toContain(leak);
    }
  });

  it('the original message appears only in the server log, redacted', async () => {
    const { app, lines, raw } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { authorization: `Bearer ${JWT}` },
    });
    const [line, ...rest] = errorLines(lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'error',
      request_id: res.headers[REQUEST_ID_HEADER],
      status: 500,
      error_code: 'internal_error',
      route: '/v1/sessions/:id',
      unexpected: true,
    });
    const err = line?.['err'] as Record<string, unknown>;
    expect(err['type']).toBe('TypeError');
    expect(err['message']).toContain("Cannot read properties of undefined (reading 'host')");
    expect(err['message']).toContain('Bearer [redacted]');
    expect(raw()).not.toContain(JWT);
  });

  it('a thrown non-Error is a generic 500 too', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/string' });
    expect(problemOf(res)).toMatchObject({
      code: 'internal_error',
      detail: ERROR_DETAILS.internal,
    });
    expect(res.payload).not.toContain('a thrown string');
  });
});

describe('routing and body errors (acceptance 5)', () => {
  const routes: Routes = (app) => {
    app.get('/v1/sessions/:id', async () => ({ ok: true }));
    app.post('/v1/items', async (request) => ({ size: JSON.stringify(request.body).length }));
    app.put('/v1/items', async () => ({ ok: true }));
    app.post('/v1/usage/events', { bodyLimit: 1024 * 1024 }, async () => ({ ok: true }));
    void app.register(
      async (child) => {
        child.delete('/things/:id', async () => ({ ok: true }));
      },
      { prefix: '/v1/child' },
    );
  };

  /** A JSON body of exactly `bytes` bytes. */
  const jsonOfSize = (bytes: number): string => `{"a":"${'x'.repeat(bytes - 8)}"}`;

  it('an unknown route is a 404 problem without an instance', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/nothing/here?x=1' });
    expect(res.statusCode).toBe(404);
    const problem = problemOf(res);
    expect(problem).toMatchObject({ code: 'not_found', detail: ERROR_DETAILS.notFound });
    expect(problem).not.toHaveProperty('instance');
  });

  it('a known URL with the wrong method is a 405 problem with an Allow header', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
    expect(problemOf(res)).toMatchObject({
      status: 405,
      code: 'invalid_request',
      detail: ERROR_DETAILS.methodNotAllowed,
    });

    const items = await app.inject({ method: 'PATCH', url: '/v1/items' });
    expect(items.statusCode).toBe(405);
    expect(items.headers['allow']).toBe('POST, PUT');
    problemOf(items);

    const child = await app.inject({ method: 'GET', url: '/v1/child/things/42' });
    expect(child.statusCode).toBe(405);
    expect(child.headers['allow']).toBe('DELETE');
  });

  it(`a body over ${DEFAULT_BODY_LIMIT_BYTES} bytes is a 413 problem; one of exactly that size is accepted`, async () => {
    const { app } = await buildApp(routes);
    const post = (payload: string, url = '/v1/items'): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(256 * 1024);

    const atLimit = await post(jsonOfSize(DEFAULT_BODY_LIMIT_BYTES));
    expect(atLimit.statusCode).toBe(200);

    const over = await post(jsonOfSize(DEFAULT_BODY_LIMIT_BYTES + 1));
    expect(over.statusCode).toBe(413);
    expect(problemOf(over)).toMatchObject({
      code: 'payload_too_large',
      detail: ERROR_DETAILS.payloadTooLarge,
    });

    // A route that sets its own limit keeps it (CT-PAGE: usage ingest takes up to 1 MiB).
    const usage = await post(jsonOfSize(300 * 1024), '/v1/usage/events');
    expect(usage.statusCode).toBe(200);
  });

  it('takes another default limit from its options', async () => {
    const { app } = await buildApp(routes, { bodyLimit: 64 });
    const post = (payload: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: { 'content-type': 'application/json' },
        payload,
      });
    expect((await post(jsonOfSize(64))).statusCode).toBe(200);
    expect(problemOf(await post(jsonOfSize(65))).code).toBe('payload_too_large');
  });

  it('refuses a body limit that is not a positive integer', async () => {
    for (const bodyLimit of [0, -1, 1.5, Number.NaN]) {
      await expect(buildApp(routes, { bodyLimit }), String(bodyLimit)).rejects.toThrow(TypeError);
    }
  });

  it('malformed JSON is a 400 problem', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"a": tru',
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res)).toMatchObject({
      code: 'invalid_request',
      detail: ERROR_DETAILS.malformedJson,
    });
  });

  it('an empty JSON body is a 400 problem and an unsupported media type a 415 problem', async () => {
    const { app } = await buildApp(routes);
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(problemOf(empty)).toMatchObject({
      status: 400,
      code: 'invalid_request',
      detail: ERROR_DETAILS.emptyJsonBody,
    });
    const xml = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(problemOf(xml)).toMatchObject({
      code: 'unsupported_media_type',
      detail: ERROR_DETAILS.unsupportedMediaType,
    });
  });

  it('a HEAD request for an unknown URL is a 404 with the request id and no body (real socket)', async () => {
    const { app } = await buildApp(routes);
    // inject() returns a body even for HEAD; Node's HTTP server is what drops it.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${address}/v1/nothing`, { method: 'HEAD' });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(REQUEST_ID_PATTERN);
      expect(await res.text()).toBe('');
    } finally {
      await app.close();
    }
  });
});

describe('errors raised before routing (guardrail: request_id on every problem)', () => {
  const routes: Routes = (app) => {
    app.get('/v1/sessions/:id', async () => ({ ok: true }));
  };

  it('a malformed URL is a 400 problem with a new request id', async () => {
    const { app, lines } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/sessions/%E0%A4%A' });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res)).toMatchObject({ code: 'invalid_request', detail: ERROR_DETAILS.badUrl });
    expect(res.payload).not.toContain('%E0');
    const [line] = errorLines(lines);
    expect(line).toMatchObject({
      level: 'debug',
      request_id: res.headers[REQUEST_ID_HEADER],
      fastify_code: 'FST_ERR_BAD_URL',
    });
    expect(JSON.stringify(lines())).not.toContain('%E0');
  });

  it("a malformed URL reuses the client's valid X-Request-Id", async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/sessions/%zz',
      headers: { [REQUEST_ID_HEADER]: REQUEST_ID },
    });
    expect(problemOf(res).request_id).toBe(REQUEST_ID);
  });

  it('an overlong URL segment is a 414 problem with the generic 4xx code (CT-ERR rule 7)', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: `/v1/sessions/${'a'.repeat(101)}` });
    expect(res.statusCode).toBe(414);
    expect(problemOf(res)).toMatchObject({
      code: 'invalid_request',
      detail: ERROR_DETAILS.uriTooLong,
    });
  });

  it('without the request context plugin, problems still get a valid request id', async () => {
    const { app, lines } = await buildApp(
      (instance) => {
        instance.get('/v1/x', async () => {
          throw forbidden();
        });
      },
      { requestContext: false },
    );
    const thrown = await app.inject({ url: '/v1/x' });
    expect(problemOf(thrown).code).toBe('forbidden');
    const missing = await app.inject({
      url: '/v1/y',
      headers: { [REQUEST_ID_HEADER]: REQUEST_ID },
    });
    expect(problemOf(missing).request_id).toBe(REQUEST_ID);
    for (const line of errorLines(lines)) expect(line['request_id']).toMatch(REQUEST_ID_PATTERN);
  });
});

describe('nothing from the request reaches a response or the log (acceptance 6)', () => {
  const secretHeaders = {
    authorization: `Bearer ${JWT}`,
    cookie: `sid=${COOKIE_VALUE}`,
    'x-api-key': LIVE_KEY,
  };
  const routes: Routes = (app) => {
    app.post('/v1/usage/events', async (request) => {
      const result = validate('api/UsageBatch', request.body);
      if (!result.ok) throw validationFailed(result.errors);
      return { ok: true };
    });
    app.get('/v1/sessions/:id', async () => ({ ok: true }));
    app.get('/v1/boom', async (request) => {
      throw new Error(`upstream refused ${String(request.headers.authorization)} ${COOKIE_VALUE}`);
    });
    app.get('/v1/careless', async (request) => {
      throw badRequest(`header was ${String(request.headers['x-api-key'])}`);
    });
  };

  it('for every kind of error, a bearer token in the body or headers is never echoed or logged', async () => {
    const { app, raw } = await buildApp(routes);
    const bodyWithToken = `{"events": [{"note": "Bearer ${JWT}", "key": "${LIVE_KEY}"`;
    const responses = await Promise.all([
      // Malformed JSON quoting the token (400).
      app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: { ...secretHeaders, 'content-type': 'application/json' },
        payload: bodyWithToken,
      }),
      // Valid JSON whose invalid field holds the token (422).
      app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: secretHeaders,
        payload: { events: [{ ...usageEvent(1), type: `Bearer ${JWT}` }] },
      }),
      // Too large (413), unsupported media type (415), wrong method (405), unknown route (404).
      app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: { ...secretHeaders, 'content-type': 'application/json' },
        payload: `{"a":"Bearer ${JWT} ${'x'.repeat(DEFAULT_BODY_LIMIT_BYTES)}"}`,
      }),
      app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: { ...secretHeaders, 'content-type': 'text/x-secret' },
        payload: `Bearer ${JWT}`,
      }),
      app.inject({
        method: 'PUT',
        url: '/v1/sessions/1',
        headers: secretHeaders,
        payload: { t: JWT },
      }),
      app.inject({ url: `/v1/nothing?token=${JWT}`, headers: secretHeaders }),
      // An unexpected error whose message quotes the header (500).
      app.inject({ url: '/v1/boom', headers: secretHeaders }),
      // A caller that put a header value into a detail: the secret is still replaced.
      app.inject({ url: '/v1/careless', headers: secretHeaders }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([400, 422, 413, 415, 405, 404, 500, 400]);
    for (const res of responses) {
      const problem = problemOf(res);
      for (const secret of [JWT, LIVE_KEY, COOKIE_VALUE]) {
        expect(res.payload, `${res.statusCode} body`).not.toContain(secret);
        expect(JSON.stringify(res.headers), `${res.statusCode} headers`).not.toContain(secret);
      }
      expect(problem.detail ?? '').not.toMatch(/Bearer [A-Za-z0-9]/);
    }
    expect(responses[7]?.json<Problem>().detail).toBe('header was [redacted]');
    const log = raw();
    for (const secret of [JWT, LIVE_KEY]) expect(log).not.toContain(secret);
  });
});

describe('guardrails', () => {
  it('only registry codes ever go out, whatever a route throws', async () => {
    let next: unknown;
    const { app } = await buildApp((instance) => {
      instance.get('/v1/throw', async () => {
        throw next;
      });
    });
    const odd = [100, 200, 302, 405, 418, 451, 507, 599, 600, 404.5, Number.NaN];
    const thrown: unknown[] = [
      ...ERROR_CODES.map((code) => new AppError(code, { retryAfterS: 7 })),
      ...odd.map((status) => new AppError('made_up' as ErrorCode, { status })),
      ...odd.map((status) => new AppError('forbidden', { status, retryAfterS: -3 })),
      new AppError('rate_limited', { retryAfterS: Number.POSITIVE_INFINITY }),
      new AppError('' as ErrorCode),
      new AppError('__proto__' as ErrorCode),
      undefined,
      null,
      0,
      '',
      'text',
      Symbol('thrown'),
      10n,
      [],
      {},
      Object.create(null),
      { code: 'forbidden', status: 403, statusCode: 403 },
      new Error('plain'),
      new RangeError('range'),
      new AggregateError([new Error('a')], 'many'),
    ];
    for (const value of thrown) {
      next = value;
      const res = await app.inject({ url: '/v1/throw' });
      problemOf(res);
    }
  });

  it('gives every authentication failure the same body, whatever the cause', async () => {
    const { app } = await buildApp((instance) => {
      instance.post('/v1/login/unknown-user', async () => {
        throw unauthorized();
      });
      instance.post('/v1/login/wrong-password', async () => {
        throw unauthorized(undefined, { cause: new Error('password mismatch') });
      });
    });
    const shape = async (
      url: string,
    ): Promise<{ body: Record<string, unknown>; headers: string[] }> => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { [REQUEST_ID_HEADER]: REQUEST_ID },
      });
      // Everything but the instance, which names the route.
      const body = Object.fromEntries(
        Object.entries(problemOf(res)).filter(([key]) => key !== 'instance'),
      );
      return { body, headers: Object.keys(res.headers).sort() };
    };
    expect(await shape('/v1/login/unknown-user')).toEqual(await shape('/v1/login/wrong-password'));
  });
});

describe('failure modes', () => {
  it('an error while building the problem falls back to the static minimal 500 body', async () => {
    const { app, lines } = await buildApp((instance) => {
      instance.get('/v1/explode', async () => {
        const err = notFound();
        Object.defineProperty(err, 'detail', {
          get() {
            throw new Error('detail getter exploded');
          },
        });
        throw err;
      });
    });
    const res = await app.inject({ url: '/v1/explode' });
    expect(res.statusCode).toBe(500);
    const problem = problemOf(res);
    expect(res.payload).toBe(fallbackProblemBody(problem.request_id));
    expect(res.payload).not.toContain('exploded');
    const [line] = errorLines(lines);
    expect(line).toMatchObject({ level: 'error', status: 500, handler_failed: true });
  });

  it('a code missing from the registry is logged as an error and sent as its status class', async () => {
    const { app, lines } = await buildApp((instance) => {
      instance.get('/v1/teapot', async () => {
        throw new AppError('teapot' as ErrorCode, { status: 418 });
      });
      instance.get('/v1/server', async () => {
        throw new AppError('made_up' as ErrorCode);
      });
    });
    const teapot = await app.inject({ url: '/v1/teapot' });
    expect(teapot.statusCode).toBe(418);
    expect(problemOf(teapot).code).toBe('invalid_request');
    const server = await app.inject({ url: '/v1/server' });
    expect(problemOf(server)).toMatchObject({ status: 500, code: 'internal_error' });
    const logged = errorLines(lines);
    expect(logged).toHaveLength(2);
    for (const line of logged) expect(line).toMatchObject({ level: 'error', unexpected: true });
    expect((logged[0]?.['err'] as Record<string, unknown>)['code']).toBe('teapot');
  });

  it('an error after the response started is logged and the connection cut, with no second response', async () => {
    const { app, lines } = await buildApp((instance) => {
      instance.get('/v1/stream', async (_request, reply) => {
        reply.raw.writeHead(200, { 'content-type': 'text/plain' });
        reply.raw.write('partial');
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('stream broke');
      });
    });
    await expect(app.inject({ url: '/v1/stream' })).rejects.toThrow(/destroyed/);
    const [line, ...rest] = errorLines(lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'error',
      status: 200,
      response_started: true,
      route: '/v1/stream',
    });
  });

  it('maps other Fastify errors by their status', async () => {
    const fastifyError = (code: string, statusCode?: number): Error =>
      Object.assign(new Error(`message quoting /v1/private/path`), { code, statusCode });
    let next: Error = new Error('unset');
    const { app, lines } = await buildApp((instance) => {
      instance.get('/v1/fst', async () => {
        throw next;
      });
    });
    for (const [error, status, code] of [
      [fastifyError('FST_ERR_HANDLER_TIMEOUT', 503), 503, 'service_unavailable'],
      [fastifyError('FST_ERR_SOMETHING', 418), 418, 'invalid_request'],
      [fastifyError('FST_ERR_SOMETHING', 404), 404, 'not_found'],
      [fastifyError('FST_ERR_NO_STATUS'), 500, 'internal_error'],
    ] as const) {
      next = error;
      const res = await app.inject({ url: '/v1/fst' });
      expect(res.statusCode, error.message).toBe(status);
      expect(problemOf(res).code).toBe(code);
      expect(res.payload).not.toContain('/v1/private/path');
    }
    expect(JSON.stringify(lines())).not.toContain('/v1/private/path');
  });
});
