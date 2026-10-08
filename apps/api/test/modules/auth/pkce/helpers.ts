/**
 * Test helpers for browser sign-in (B018): the API as it will run (request context, error handler,
 * optional rate limiter, auth plugin, the web cookie rules, B017's token route and the authorize
 * route) on B017's in-memory token service and the in-memory Redis (B009), a test route that
 * stands in for the login lanes by calling `establishLoginSession`, PKCE pairs, a KeyValue that
 * records writes, and small HTTP helpers.
 */
import { randomBytes } from 'node:crypto';
import {
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  type Env,
  type KeyValue,
} from '@centcom/core';
import { fastify, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { Authorizer, AUTHORIZE_PATH } from '../../../../src/modules/auth/pkce/authorize.js';
import { AuthorizationCodeStore } from '../../../../src/modules/auth/pkce/code-store.js';
import { loadPkceConfig, type PkceConfig } from '../../../../src/modules/auth/pkce/config.js';
import { registerAuthorizationCodeGrant } from '../../../../src/modules/auth/pkce/grant-handler.js';
import { s256 } from '../../../../src/modules/auth/pkce/pkce.js';
import {
  REFRESH_COOKIE,
  webTokenCookiePlugin,
} from '../../../../src/modules/auth/web-session/cookies.js';
import {
  createLoginSessions,
  type LoginSessions,
} from '../../../../src/modules/auth/web-session/store.js';
import { authPlugin } from '../../../../src/plugins/auth.js';
import {
  errorHandlerPlugin,
  frameworkErrorHandler,
} from '../../../../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../../../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../../../src/plugins/request-context.js';
import { authorizeRoutes } from '../../../../src/routes/auth/authorize.js';
import { tokenRoutes } from '../../../../src/routes/auth/token.js';
import { captureLogger } from '../../../helpers.js';
import { memoryTokens, newId, type TestClock } from '../tokens/helpers.js';

export { newId };

export const WEB_ORIGIN = 'https://app.centcom.test';
export const WEB_CALLBACK = 'https://app.centcom.test/auth/callback';
export const LOGIN_URL = 'https://app.centcom.test/login';
export const CLI_CALLBACK = 'http://127.0.0.1/callback';
export const TUI_CALLBACK = 'http://[::1]/callback';
export const DESKTOP_CALLBACK = 'centcom://auth/callback';

/** The configuration the tests run with. */
export const TEST_ENV: Env = {
  AUTH_REDIRECT_URIS: JSON.stringify({
    'centcom-web': [WEB_CALLBACK],
    'centcom-cli': [CLI_CALLBACK, DESKTOP_CALLBACK],
    'centcom-tui': [TUI_CALLBACK],
  }),
  WEB_LOGIN_URL: LOGIN_URL,
  WEB_ALLOWED_ORIGINS: WEB_ORIGIN,
};

/** The headers a well-behaved web client sends to the token endpoint. */
export const WEB_HEADERS = { 'x-centcom-client': 'web', origin: WEB_ORIGIN } as const;

/** A PKCE pair: a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

/** A KeyValue that records every key and value written, around a real one. */
export function recordingKv(
  inner: KeyValue,
): KeyValue & { writes: { key: string; value: string }[] } {
  const writes: { key: string; value: string }[] = [];
  return {
    writes,
    get: (key) => inner.get(key),
    set: (key, value, opts) => {
      writes.push({ key, value });
      return inner.set(key, value, opts);
    },
    setIfAbsent: (key, value, ttlMs) => {
      writes.push({ key, value });
      return inner.setIfAbsent(key, value, ttlMs);
    },
    del: (key) => inner.del(key),
    incr: (key, ttlMs) => inner.incr(key, ttlMs),
    ttl: (key) => inner.ttl(key),
  };
}

/** A KeyValue whose every call fails the way `failure` says. */
export function failingKv(failure: () => Error): KeyValue {
  const fail = (): Promise<never> => Promise.reject(failure());
  return { get: fail, set: fail, setIfAbsent: fail, del: fail, incr: fail, ttl: fail };
}

/** Everything a test may need from the assembled API. */
export type PkceHarness = Awaited<ReturnType<typeof pkceApp>>;

/**
 * The API with browser sign-in. `kv` replaces the Redis the codes and sessions use (the token
 * service keeps the in-memory one); `rateLimit` adds B023's limiter with CT-PAGE's buckets.
 */
export async function pkceApp(
  opts: { kv?: KeyValue; rateLimit?: boolean; env?: Env; clock?: TestClock } = {},
) {
  const captured = captureLogger();
  const { tokens, store, redis, clock, keys } = memoryTokens(
    opts.clock === undefined ? {} : { clock: opts.clock },
  );
  const kv = recordingKv(opts.kv ?? redis.kv);
  const config: PkceConfig = loadPkceConfig(opts.env ?? TEST_ENV);
  const codes = new AuthorizationCodeStore({ kv });
  const sessions: LoginSessions = createLoginSessions({ kv, now: clock.now });
  const authorizer = new Authorizer({
    codes,
    redirects: config.redirects,
    loginUrl: config.loginUrl,
    keys,
    now: clock.now,
  });
  registerAuthorizationCodeGrant({ tokens, codes, now: clock.now, logger: captured.logger });

  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  if (opts.rateLimit === true) {
    await app.register(rateLimitPlugin, {
      store: createMemoryRedis(clock.now).rateLimit,
      config: { buckets: defaultBuckets, trustedHops: 0, exempt: DEFAULT_EXEMPT_ROUTES },
      clock: clock.now,
    });
  }
  await app.register(authPlugin, { tokens });
  await app.register(webTokenCookiePlugin, { allowedOrigins: config.allowedOrigins });
  await app.register(tokenRoutes, { tokens });
  await app.register(authorizeRoutes, { authorizer, sessions });
  // Stands in for the login lanes (B014, B015): signs `user_id` in for this browser.
  app.post('/v1/test/login', { config: { auth: false } }, async (request, reply) => {
    await sessions.establishLoginSession(reply, (request.body as { user_id: string }).user_id);
    return { ok: true };
  });
  app.post('/v1/test/logout', { config: { auth: false } }, async (request, reply) => {
    await sessions.endLoginSession(request, reply);
    return { ok: true };
  });
  app.get('/v1/test/me', async (request) => ({ user: request.principal?.userId ?? null }));
  await app.ready();
  return { app, tokens, store, clock, keys, kv, codes, sessions, authorizer, config, captured };
}

/** Every Set-Cookie header of a response. */
export function setCookies(res: LightMyRequestResponse): string[] {
  const header = res.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

/** The Set-Cookie header for cookie `name`, if any. */
export const setCookie = (res: LightMyRequestResponse, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));

/** The value a response sets for cookie `name`, if any. */
export function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  const header = setCookie(res, name);
  return header?.slice(name.length + 1).split(';')[0];
}

/** Signs `userId` in through the test login route; the Cookie header value of its session. */
export async function login(
  app: FastifyInstance,
  userId: string,
  cookie?: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/test/login',
    payload: { user_id: userId },
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  return `centcom_sid=${cookieValue(res, 'centcom_sid') ?? ''}`;
}

/** Authorize parameters for the CLI on its loopback callback, with `overrides`. */
export function authorizeParams(
  challenge: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: 'centcom-cli',
    redirect_uri: 'http://127.0.0.1:53682/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The authorize URL for `params`. */
export const authorizeUrl = (params: Record<string, string>): string =>
  `${AUTHORIZE_PATH}?${new URLSearchParams(params).toString()}`;

/** Calls authorize as the browser with session `cookie` (none when undefined). */
export function authorize(
  app: FastifyInstance,
  params: Record<string, string>,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: authorizeUrl(params),
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

/** The code on a code redirect (fails the test when there is none). */
export function codeOf(res: LightMyRequestResponse): string {
  const location = String(res.headers['location']);
  const code = new URL(location.replace(/^centcom:/, 'https:')).searchParams.get('code');
  if (res.statusCode !== 302 || code === null) throw new Error(`no code in ${res.statusCode}`);
  return code;
}

/** Signs a user in and gets a code for `params`; returns the code and the user. */
export async function issueCode(
  app: FastifyInstance,
  params: Record<string, string>,
  userId = newId('usr'),
): Promise<{ code: string; userId: string; cookie: string }> {
  const cookie = await login(app, userId);
  return { code: codeOf(await authorize(app, params, cookie)), userId, cookie };
}

/** Calls the token endpoint with a JSON body. */
export function tokenRequest(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v1/auth/token', payload: body, headers });
}

/** Exchanges a code with the token endpoint. */
export function exchange(
  app: FastifyInstance,
  fields: { code: string; verifier: string; redirectUri: string; clientId?: string },
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return tokenRequest(
    app,
    {
      grant_type: 'authorization_code',
      code: fields.code,
      code_verifier: fields.verifier,
      redirect_uri: fields.redirectUri,
      client_id: fields.clientId ?? 'centcom-cli',
    },
    headers,
  );
}

/** Calls `/v1/test/me` with an access token. */
export function whoAmI(app: FastifyInstance, accessToken: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: '/v1/test/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/** The refresh cookie as a Cookie header value. */
export const refreshCookie = (value: string): string => `${REFRESH_COOKIE}=${value}`;
