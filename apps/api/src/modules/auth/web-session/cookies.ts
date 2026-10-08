/**
 * Web cookies (B018, CT-AUTH "Web sessions"): the browser login session cookie (`centcom_sid`)
 * and the web client's refresh cookie (`centcom_rt`), both `HttpOnly; Secure; SameSite=Lax`, the
 * refresh cookie scoped to `/v1/auth/token`.
 *
 * `webTokenCookiePlugin` adds the web client's rules to B017's token endpoint without changing it:
 * a `centcom-web` request needs `X-Centcom-Client: web` and an allowed `Origin` (else 403
 * `forbidden`, no cookie), refreshes with the cookie (never a `refresh_token` parameter), and gets
 * its refresh token only as the cookie, never in the JSON. A failed cookie refresh clears the
 * cookie. Register the plugin before `tokenRoutes`: the API refuses to start otherwise.
 *
 * Owns: cookie names, attributes and the web rules on the token endpoint. Must not: put a refresh
 * token in a web client's response body, or set a cookie on a refused request.
 */
import { AppError } from '@centcom/core';
import type { ClientId } from '@centcom/db';
import type { FastifyPluginAsync, FastifyRequest, RouteOptions } from 'fastify';
import { REFRESH_SLIDING_MS } from '../tokens/refresh.js';

/** The browser client (CT-AUTH). */
export const WEB_CLIENT_ID: ClientId = 'centcom-web';
/** The CSRF header the web client sends, with the value `web`. */
export const WEB_CLIENT_HEADER = 'x-centcom-client';
/** B017's token endpoint. */
export const TOKEN_PATH = '/v1/auth/token';
/** The web client's refresh token. */
export const REFRESH_COOKIE = 'centcom_rt';
/** The browser login session. */
export const LOGIN_SESSION_COOKIE = 'centcom_sid';

/** A Set-Cookie value with the attributes every cookie here carries. */
function cookie(name: string, value: string, path: string, maxAgeS: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Sets the refresh cookie (lives as long as the refresh token may slide: 30 days). */
export const refreshCookieHeader = (refreshToken: string): string =>
  cookie(REFRESH_COOKIE, refreshToken, TOKEN_PATH, REFRESH_SLIDING_MS / 1000);

/** Removes the refresh cookie (logout, or a refresh that failed). */
export const clearRefreshCookieHeader = (): string => cookie(REFRESH_COOKIE, '', TOKEN_PATH, 0);

/** Sets the login session cookie for `maxAgeS` seconds. */
export const loginSessionCookieHeader = (sessionId: string, maxAgeS: number): string =>
  cookie(LOGIN_SESSION_COOKIE, sessionId, '/', maxAgeS);

/** Removes the login session cookie. */
export const clearLoginSessionCookieHeader = (): string => cookie(LOGIN_SESSION_COOKIE, '', '/', 0);

/** The value of cookie `name` in a Cookie header (the first one wins), or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** Options for `webTokenCookiePlugin`. */
export interface WebTokenCookieOptions {
  /** Origins the web client may call from (`WEB_ALLOWED_ORIGINS`), compared exactly. */
  allowedOrigins: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adds `hook` after a route's own hooks of that kind. */
function appendHook<T>(existing: T | T[] | undefined, hook: T): T[] {
  if (existing === undefined) return [hook];
  return Array.isArray(existing) ? [...existing, hook] : [existing, hook];
}

const isTokenRoute = (route: RouteOptions): boolean =>
  route.url === TOKEN_PATH &&
  (Array.isArray(route.method) ? route.method.includes('POST') : route.method === 'POST');

const plugin: FastifyPluginAsync<WebTokenCookieOptions> = async (app, { allowedOrigins }) => {
  /** Web requests that passed the guard, and which of them refresh with the cookie. */
  const web = new WeakMap<FastifyRequest, { refresh: boolean }>();
  let attached = false;

  async function guard(request: FastifyRequest): Promise<void> {
    const body = request.body;
    if (!isRecord(body) || body['client_id'] !== WEB_CLIENT_ID) return;
    const origin = request.headers.origin;
    if (
      request.headers[WEB_CLIENT_HEADER] !== 'web' ||
      typeof origin !== 'string' ||
      !allowedOrigins.has(origin)
    ) {
      throw new AppError('forbidden', {
        detail: 'The web client must send X-Centcom-Client: web from an allowed origin.',
      });
    }
    const refresh = body['grant_type'] === 'refresh_token';
    if (refresh) {
      if (body['refresh_token'] !== undefined) {
        throw new AppError('invalid_request', {
          detail: 'The web client refreshes with its cookie, not a refresh_token parameter.',
        });
      }
      const token = readCookie(request.headers.cookie, REFRESH_COOKIE);
      if (token === undefined || token === '') {
        throw new AppError('invalid_request', { detail: 'The refresh cookie is missing.' });
      }
      request.body = { ...body, refresh_token: token };
    }
    web.set(request, { refresh });
  }

  app.addHook('onRoute', (route) => {
    if (!isTokenRoute(route)) return;
    attached = true;
    route.preHandler = appendHook(route.preHandler, async (request) => guard(request));
    // Successful web responses: the refresh token leaves the body for the cookie.
    route.preSerialization = appendHook(
      route.preSerialization,
      async (request, reply, payload: unknown) => {
        if (!web.has(request) || !isRecord(payload)) return payload;
        const { refresh_token: refreshToken, ...rest } = payload;
        if (typeof refreshToken !== 'string') return payload;
        void reply.header('set-cookie', refreshCookieHeader(refreshToken));
        return rest;
      },
    );
    // A cookie refresh that failed (spent, revoked, expired): the cookie is of no further use.
    route.onSend = appendHook(route.onSend, async (request, reply, payload: unknown) => {
      if (web.get(request)?.refresh === true && reply.statusCode >= 400 && reply.statusCode < 500) {
        void reply.header('set-cookie', clearRefreshCookieHeader());
      }
      return payload;
    });
  });

  app.addHook('onReady', async () => {
    if (!attached) {
      throw new Error(
        `webTokenCookiePlugin: no POST ${TOKEN_PATH} route was registered after it; register it before tokenRoutes`,
      );
    }
  });
};

/** The web client's rules on `POST /v1/auth/token`; register it before `tokenRoutes`. */
export const webTokenCookiePlugin = Object.assign(plugin, {
  // Fastify's documented alternative to fastify-plugin: the hooks apply to the parent instance.
  [Symbol.for('skip-override')]: true,
});
