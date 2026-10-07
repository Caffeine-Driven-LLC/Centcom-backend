/**
 * Rate-limit plugin (B023; card test plugin.test.ts and acceptance 1-9 end to end): the plugin on
 * the API's plugin stack over B009's in-memory store on a fake clock. Test headers stand in for
 * the B017 auth plugin's principal (`x-test-user`, `x-test-device`, `x-test-key`).
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  RATE_LIMITED_DETAIL,
  unavailable,
  type RateLimitConfig,
  type RateLimitPrincipal,
  type RateLimitStore,
} from '@centcom/core';
import {
  fastify,
  type FastifyInstance,
  type FastifyRequest,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger, recordingMetrics } from './helpers.js';

class FakeClock {
  now = Date.UTC(2026, 9, 7, 12, 0, 0);
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

const CLIENT = '203.0.113.7';
const OTHER = '198.51.100.9';
const PROXY = '10.0.0.2';
const INTEGER = /^\d+$/;

/** The B017 stand-in: who calls, from test headers; `x-test-bad` is a credential that fails. */
function headerPrincipal(request: FastifyRequest): RateLimitPrincipal | null {
  if (request.headers['x-test-bad'] !== undefined) {
    throw new AppError('token_invalid', { detail: 'The access token is not valid.' });
  }
  const user = request.headers['x-test-user'];
  const device = request.headers['x-test-device'];
  const key = request.headers['x-test-key'];
  if (typeof user === 'string') {
    return {
      kind: 'user',
      userId: user,
      ...(typeof device === 'string' ? { deviceId: device } : {}),
    };
  }
  return typeof key === 'string' ? { kind: 'api_key', keyId: key } : null;
}

/** The API's plugin stack with the rate limiter and a few routes, each counting its handler calls. */
async function limitedApp(
  opts: { config?: Partial<RateLimitConfig>; store?: RateLimitStore; principal?: false } = {},
) {
  const clock = new FakeClock();
  const backend = createMemoryRedis(clock.read);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const handled: string[] = [];
  const parsed: string[] = [];
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(rateLimitPlugin, {
    store: opts.store ?? backend.rateLimit,
    kv: backend.kv,
    config: {
      buckets: defaultBuckets,
      trustedHops: 0,
      exempt: DEFAULT_EXEMPT_ROUTES,
      ...opts.config,
    },
    clock: clock.read,
    ...(opts.principal === false ? {} : { principal: headerPrincipal }),
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  app.addHook('preParsing', async (request) => {
    parsed.push(request.routeOptions.url ?? '(unmatched)');
  });
  const handler = (name: string) => async () => {
    handled.push(name);
    return { ok: true };
  };
  app.get('/v1/things/:id', handler('things'));
  app.get('/v1/status', handler('status'));
  app.delete('/v1/status-only-get', handler('never'));
  app.get('/healthz', handler('healthz'));
  app.get('/readyz', handler('readyz'));
  app.post('/v1/auth/token', handler('token'));
  app.post('/v1/usage/events', { config: { rateLimit: { bucket: 'usage' } } }, handler('usage'));
  // A costly route, where the buckets hold its cost (startup refuses it otherwise).
  const { anonymous, user, apiKey } = opts.config?.buckets ?? defaultBuckets;
  if (Math.min(anonymous.limit, user.limit, apiKey.limit) >= 10) {
    app.post(
      '/v1/imports',
      { config: { rateLimit: { bucket: 'default', cost: 10 } } },
      handler('imports'),
    );
  }
  await app.ready();
  return { app, clock, handled, parsed, captured, recorded };
}

/** Sends `n` requests one after another. */
async function times(
  app: FastifyInstance,
  n: number,
  request: InjectOptions | ((i: number) => InjectOptions),
): Promise<LightMyRequestResponse[]> {
  const responses: LightMyRequestResponse[] = [];
  for (let i = 0; i < n; i++) {
    responses.push(await app.inject(typeof request === 'function' ? request(i) : request));
  }
  return responses;
}

const statuses = (responses: readonly LightMyRequestResponse[]): number[] =>
  responses.map((r) => r.statusCode);
const ok = (responses: readonly LightMyRequestResponse[]): number =>
  statuses(responses).filter((s) => s === 200).length;

describe('the rate-limit plugin', () => {
  it('lets 30 anonymous requests a minute through, counting down, and refuses the 31st (acceptance 1)', async () => {
    const { app, handled } = await limitedApp();
    // A different URL each time: one route, one bucket (keys never use the raw URL).
    const first = await times(app, 30, (i) => ({
      url: `/v1/things/${i}?v=${i}`,
      remoteAddress: CLIENT,
    }));
    expect(statuses(first)).toEqual(Array(30).fill(200));
    expect(first.map((r) => r.headers['ratelimit-remaining'])).toEqual(
      Array.from({ length: 30 }, (_, i) => String(29 - i)),
    );
    expect(first.every((r) => r.headers['ratelimit-limit'] === '30')).toBe(true);
    const refused = await app.inject({ url: '/v1/things/31', remoteAddress: CLIENT });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toBe('application/problem+json');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.json()).toEqual({
      type: 'https://centcom.dev/errors/rate_limited',
      title: 'Rate limited',
      status: 429,
      code: 'rate_limited',
      detail: RATE_LIMITED_DETAIL,
      instance: '/v1/things/:id',
      request_id: expect.stringMatching(/^req_/) as string,
      retry_after_s: retryAfter,
    });
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    expect(handled).toHaveLength(30);
  });

  it('limits a user at 600 a minute by id from any address, and an API key at 1200 (acceptance 2)', async () => {
    const { app } = await limitedApp();
    const user = newId('usr');
    const asUser = await times(app, 601, (i) => ({
      url: '/v1/things/1',
      remoteAddress: i % 2 === 0 ? CLIENT : OTHER,
      headers: { 'x-test-user': user },
    }));
    expect(ok(asUser)).toBe(600);
    expect(asUser[600]?.statusCode).toBe(429);
    expect(asUser[0]?.headers['ratelimit-limit']).toBe('600');
    // Another user, and anonymous callers at the same addresses, have buckets of their own.
    const other = await app.inject({
      url: '/v1/things/1',
      remoteAddress: CLIENT,
      headers: { 'x-test-user': newId('usr') },
    });
    expect(other.headers['ratelimit-remaining']).toBe('599');
    const anonymous = await app.inject({ url: '/v1/things/1', remoteAddress: CLIENT });
    expect(anonymous.headers['ratelimit-remaining']).toBe('29');
    const key = newId('key');
    const withKey = await times(app, 1201, (i) => ({
      url: '/v1/things/1',
      remoteAddress: i % 2 === 0 ? CLIENT : OTHER,
      headers: { 'x-test-key': key },
    }));
    expect(ok(withKey)).toBe(1200);
    expect(withKey[1200]?.statusCode).toBe(429);
    expect(withKey[0]?.headers['ratelimit-limit']).toBe('1200');
  });

  it('limits POST /v1/auth/token at 20 a minute per address, whoever calls (acceptance 3)', async () => {
    const { app } = await limitedApp();
    const token = { method: 'POST' as const, url: '/v1/auth/token', remoteAddress: CLIENT };
    const responses = await times(app, 21, token);
    expect(ok(responses)).toBe(20);
    expect(responses[20]?.statusCode).toBe(429);
    expect(responses[0]?.headers['ratelimit-limit']).toBe('20');
    // A signed-in caller at the same address shares the address's auth bucket.
    const signedIn = await app.inject({ ...token, headers: { 'x-test-user': newId('usr') } });
    expect(signedIn.statusCode).toBe(429);
    const elsewhere = await app.inject({ ...token, remoteAddress: OTHER });
    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.headers['ratelimit-remaining']).toBe('19');
    // Unmatched URLs under /v1/auth/ have no route template: the caller's own bucket.
    const unmatched = await app.inject({ url: '/v1/auth/nope', remoteAddress: OTHER });
    expect(unmatched.statusCode).toBe(404);
    expect(unmatched.headers['ratelimit-limit']).toBe('30');
  });

  it('limits POST /v1/usage/events at 60 a minute per device (acceptance 4)', async () => {
    const { app } = await limitedApp();
    const user = newId('usr');
    const usage = (device: string): InjectOptions => ({
      method: 'POST',
      url: '/v1/usage/events',
      remoteAddress: CLIENT,
      headers: { 'x-test-user': user, 'x-test-device': device },
    });
    const device = newId('dev');
    const responses = await times(app, 61, usage(device));
    expect(ok(responses)).toBe(60);
    expect(responses[60]?.statusCode).toBe(429);
    expect(responses[0]?.headers['ratelimit-limit']).toBe('60');
    const otherDevice = await app.inject(usage(newId('dev')));
    expect(otherDevice.statusCode).toBe(200);
    expect(otherDevice.headers['ratelimit-remaining']).toBe('59');
  });

  it('puts integer RateLimit-* headers on 200, 404, 405 and 429 responses (acceptance 5)', async () => {
    const { app } = await limitedApp({
      config: { buckets: { ...defaultBuckets, anonymous: { limit: 3, windowS: 60 } } },
    });
    const responses = [
      await app.inject({ url: '/v1/status', remoteAddress: CLIENT }),
      await app.inject({ url: '/v1/missing', remoteAddress: CLIENT }),
      await app.inject({ method: 'GET', url: '/v1/status-only-get', remoteAddress: CLIENT }),
      await app.inject({ url: '/v1/status', remoteAddress: CLIENT }),
    ];
    expect(statuses(responses)).toEqual([200, 404, 405, 429]);
    for (const response of responses) {
      expect(response.headers['ratelimit-limit']).toMatch(INTEGER);
      expect(response.headers['ratelimit-remaining']).toMatch(INTEGER);
      expect(response.headers['ratelimit-reset']).toMatch(INTEGER);
    }
    expect(responses.map((r) => r.headers['ratelimit-remaining'])).toEqual(['2', '1', '0', '0']);
  });

  it('keys on the address the trusted proxy saw, whatever the client wrote (acceptance 6)', async () => {
    const { app } = await limitedApp({ config: { trustedHops: 1 } });
    const via = (forwarded: string) =>
      app.inject({
        url: '/v1/status',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': forwarded },
      });
    const remaining = async (forwarded: string): Promise<string> =>
      String((await via(forwarded)).headers['ratelimit-remaining']);
    expect(await remaining(CLIENT)).toBe('29');
    expect(await remaining(`1.1.1.1, ${CLIENT}`)).toBe('28');
    expect(await remaining(`9.9.9.9, 8.8.8.8, ${CLIENT}`)).toBe('27');
    expect(await remaining(OTHER)).toBe('29');
    // With no trusted proxy, the header counts for nothing: everyone here is the proxy's address.
    const direct = await limitedApp({ config: { trustedHops: 0 } });
    const viaDirect = (forwarded: string) =>
      direct.app.inject({
        url: '/v1/status',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': forwarded },
      });
    expect((await viaDirect(CLIENT)).headers['ratelimit-remaining']).toBe('29');
    expect((await viaDirect(OTHER)).headers['ratelimit-remaining']).toBe('28');
  });

  it('keeps limiting per process when the store throws, the auth bucket at 20 (acceptance 7)', async () => {
    const failing: RateLimitStore = {
      consume: () => Promise.reject(unavailable(1, 'redis unavailable')),
    };
    const { app, recorded, captured } = await limitedApp({ store: failing });
    const general = await times(app, 61, { url: '/v1/status', remoteAddress: CLIENT });
    expect(ok(general)).toBe(60);
    expect(general[60]?.statusCode).toBe(429);
    expect(general[0]?.headers['ratelimit-limit']).toBe('60');
    const auth = await times(app, 21, {
      method: 'POST',
      url: '/v1/auth/token',
      remoteAddress: OTHER,
    });
    expect(ok(auth)).toBe(20);
    expect(auth[20]?.statusCode).toBe(429);
    expect(auth[0]?.headers['ratelimit-limit']).toBe('20');
    expect(recorded.count('ratelimit_store_errors_total')).toBeGreaterThanOrEqual(1);
    expect(captured.lines().some((l) => l['msg'] === 'ratelimit.store_unavailable')).toBe(true);
  });

  it('exempts /healthz and /readyz, and counts /v1/status in the anonymous bucket (acceptance 8)', async () => {
    const { app, handled } = await limitedApp();
    for (const url of ['/healthz', '/readyz']) {
      for (const method of ['GET', 'HEAD'] as const) {
        const responses = await times(app, 50, { method, url, remoteAddress: CLIENT });
        expect(statuses(responses).every((s) => s === 200)).toBe(true);
        expect(responses.some((r) => r.headers['ratelimit-limit'] !== undefined)).toBe(false);
      }
    }
    expect(handled.filter((h) => h === 'healthz')).toHaveLength(100);
    const status = await times(app, 31, { url: '/v1/status', remoteAddress: CLIENT });
    expect(status[0]?.headers['ratelimit-limit']).toBe('30');
    expect(ok(status)).toBe(30);
    expect(status[30]?.statusCode).toBe(429);
  });

  it('starts counting afresh once the window has passed (acceptance 9)', async () => {
    const { app, clock } = await limitedApp();
    const full = await times(app, 31, { url: '/v1/status', remoteAddress: CLIENT });
    expect(full[30]?.statusCode).toBe(429);
    clock.advance(60_000);
    const fresh = await app.inject({ url: '/v1/status', remoteAddress: CLIENT });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers['ratelimit-remaining']).toBe('29');
  });
});

describe('the rate-limit plugin guardrails', () => {
  it('refuses before body parsing and the handler', async () => {
    const { app, handled, parsed } = await limitedApp({
      config: { buckets: { ...defaultBuckets, auth: { limit: 1, windowS: 60 } } },
    });
    const post = {
      method: 'POST' as const,
      url: '/v1/auth/token',
      remoteAddress: CLIENT,
      payload: { a: 1 },
    };
    expect((await app.inject(post)).statusCode).toBe(200);
    expect((await app.inject(post)).statusCode).toBe(429);
    expect(handled).toEqual(['token']);
    expect(parsed).toEqual(['/v1/auth/token']);
  });

  it('answers every bucket with the same 429 shape', async () => {
    const { app } = await limitedApp({
      config: {
        buckets: {
          anonymous: { limit: 1, windowS: 60 },
          user: { limit: 1, windowS: 60 },
          apiKey: { limit: 1, windowS: 60 },
          auth: { limit: 1, windowS: 60 },
          usage: { limit: 1, windowS: 60 },
        },
      },
    });
    const requests: InjectOptions[] = [
      { url: '/v1/status', remoteAddress: CLIENT },
      { url: '/v1/status', headers: { 'x-test-user': newId('usr') } },
      { url: '/v1/status', headers: { 'x-test-key': newId('key') } },
      { method: 'POST', url: '/v1/auth/token', remoteAddress: OTHER },
      {
        method: 'POST',
        url: '/v1/usage/events',
        headers: { 'x-test-user': newId('usr'), 'x-test-device': newId('dev') },
      },
    ];
    const shapes = new Set<string>();
    for (const request of requests) {
      await app.inject(request);
      const refused = await app.inject(request);
      expect(refused.statusCode).toBe(429);
      const body = refused.json<Record<string, unknown>>();
      expect(body['detail']).toBe(RATE_LIMITED_DETAIL);
      shapes.add(Object.keys(body).sort().join(','));
    }
    expect(shapes.size).toBe(1);
  });

  it('charges a route its declared cost', async () => {
    const { app } = await limitedApp();
    const imports = await times(app, 4, {
      method: 'POST',
      url: '/v1/imports',
      remoteAddress: CLIENT,
    });
    expect(imports.map((r) => r.headers['ratelimit-remaining'])).toEqual(['20', '10', '0', '0']);
    expect(statuses(imports)).toEqual([200, 200, 200, 429]);
  });

  it('lets exactly 30 of 100 parallel requests through', async () => {
    const { app } = await limitedApp();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => app.inject({ url: '/v1/status', remoteAddress: CLIENT })),
    );
    expect(ok(responses)).toBe(30);
    expect(statuses(responses).filter((s) => s === 429)).toHaveLength(70);
  });

  it('blocks an address that keeps overrunning the auth bucket, but not users signed in from it', async () => {
    const { app, recorded } = await limitedApp();
    await times(app, 25, { method: 'POST', url: '/v1/auth/token', remoteAddress: CLIENT });
    expect(recorded.count('ratelimit_blocks_total')).toBe(1);
    const blocked = await app.inject({ url: '/v1/status', remoteAddress: CLIENT });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(850);
    const signedIn = await app.inject({
      url: '/v1/status',
      remoteAddress: CLIENT,
      headers: { 'x-test-user': newId('usr') },
    });
    expect(signedIn.statusCode).toBe(200);
  });

  it('counts a failed credential as anonymous before its 401 goes out', async () => {
    const { app, handled } = await limitedApp();
    const bad = { url: '/v1/status', remoteAddress: CLIENT, headers: { 'x-test-bad': '1' } };
    const responses = await times(app, 31, bad);
    expect(statuses(responses)).toEqual([...Array<number>(30).fill(401), 429]);
    expect(responses[0]?.json()).toMatchObject({ code: 'token_invalid' });
    expect(responses.map((r) => r.headers['ratelimit-remaining']).slice(0, 3)).toEqual([
      '29',
      '28',
      '27',
    ]);
    // The address's anonymous bucket is spent on them.
    expect((await app.inject({ url: '/v1/status', remoteAddress: CLIENT })).statusCode).toBe(429);
    expect(handled).toEqual([]);
  });

  it('treats everyone as anonymous without a principal function', async () => {
    const { app } = await limitedApp({ principal: false });
    const response = await app.inject({
      url: '/v1/status',
      remoteAddress: CLIENT,
      headers: { 'x-test-user': newId('usr') },
    });
    expect(response.headers['ratelimit-limit']).toBe('30');
  });

  it.each([
    [{ bucket: 'mystery' }],
    [null],
    [{ cost: 1 }],
    [{ bucket: 'auth', cost: 21 }],
    [{ bucket: 'default', cost: 31 }],
    [{ bucket: 'usage', cost: 0 }],
    [{ bucket: 'default', cost: 1.5 }],
  ])('refuses the route config %j at startup', async (rateLimit) => {
    const app = fastify({ logger: false });
    await app.register(rateLimitPlugin, {
      store: createMemoryRedis().rateLimit,
      config: { buckets: defaultBuckets, trustedHops: 0, exempt: DEFAULT_EXEMPT_ROUTES },
    });
    await expect(async () => {
      app.get('/v1/x', { config: { rateLimit: rateLimit as never } }, async () => ({}));
      await app.ready();
    }).rejects.toThrow(TypeError);
    await app.close();
  });
});
