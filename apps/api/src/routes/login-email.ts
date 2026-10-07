/**
 * Browser routes of e-mail sign-in (B014, outside the /v1 contract):
 *
 * - `POST /login/email` `{email, return_to?}` (form or JSON): 202 with the same page for every
 *   address, and the browser's nonce cookie (kept when it already has one). A malformed address is
 *   a 422.
 * - `GET /login/email/verify?t=`: a page whose button POSTs the link back; nothing else happens.
 * - `POST /login/email/verify` `{t, csrf}` with the nonce cookie: signs in through the
 *   `LoginCompleter` (B018 wires the web session), which ends with a 303 to `return_to`.
 *
 * Both POSTs count in the rate limiter's `auth` bucket (B023, 20/min per address).
 *
 * Owns: the HTTP side of e-mail sign-in. Must not: let a response differ by account, change
 * anything on a GET, accept a form from another site, or let a page be cached.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isAppError, type Logger } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  confirmPage,
  failedPage,
  invalidEmailPage,
  otherBrowserPage,
  sentPage,
} from '../modules/auth/magic-link/pages.js';
import {
  MagicLinkError,
  newSecret,
  SECRET_SHAPE,
  type MagicLinkService,
} from '../modules/auth/magic-link/service.js';
import { readCookie } from '../modules/auth/social/oauth-state.js';
import { checkLocale } from '../modules/users/index.js';
import type { LoginCompleter } from './login-social.js';

/** The cookie that binds a link to the browser that asked for it. */
export const NONCE_COOKIE = 'centcom_login_nonce';
/** Where the cookie is sent: only these routes. */
export const NONCE_COOKIE_PATH = '/login/email';
/** The largest form or JSON body these routes read. */
export const LOGIN_BODY_LIMIT = 8 * 1024;

/** Options for `emailLoginRoutes`. */
export interface EmailLoginRouteOptions {
  magicLink: MagicLinkService;
  completer: LoginCompleter;
  /** How long the nonce cookie lives (MAGIC_LINK_TTL_S). */
  ttlS: number;
  logger?: Logger;
  /** Mark the cookie `Secure`; default true (turn off only for http://localhost development). */
  secureCookies?: boolean;
}

/** The CSRF token of a nonce: only a page from this origin, which reads the cookie, can know it. */
export const csrfFor = (nonce: string): string =>
  createHash('sha256').update(`centcom-login-csrf:${nonce}`, 'utf8').digest('base64url');

const csrfMatches = (given: unknown, nonce: string): boolean => {
  const expected = Buffer.from(csrfFor(nonce), 'utf8');
  const actual = Buffer.from(typeof given === 'string' ? given : '', 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** The nonce cookie, if the browser sent a well-formed one. */
const nonceOf = (cookies: string | undefined): string | undefined => {
  const value = readCookie(cookies, NONCE_COOKIE);
  return value !== undefined && SECRET_SHAPE.test(value) ? value : undefined;
};

/** The browser's first Accept-Language tag, if it is a valid one; else `en`. */
const localeOf = (header: string | undefined): string => {
  const first = header?.split(',')[0]?.split(';')[0]?.trim();
  return first === undefined || first === '' ? 'en' : (checkLocale(first).value ?? 'en');
};

/** Every page: HTML, never cached, no scripts, forms only to this origin, no referrer. */
const asPage = (reply: FastifyReply, status: number): FastifyReply =>
  reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; form-action 'self'")
    .header('referrer-policy', 'no-referrer');

export const emailLoginRoutes: FastifyPluginAsync<EmailLoginRouteOptions> = async (app, opts) => {
  const secure = opts.secureCookies ?? true;
  const nonceCookie = (nonce: string): string =>
    [
      `${NONCE_COOKIE}=${nonce}`,
      `Path=${NONCE_COOKIE_PATH}`,
      `Max-Age=${opts.ttlS}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(secure ? ['Secure'] : []),
    ].join('; ');

  // HTML forms post url-encoded bodies; this parser exists only inside these routes.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: LOGIN_BODY_LIMIT },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const fields = (body: unknown): Record<string, unknown> =>
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  app.post(
    '/login/email',
    { bodyLimit: LOGIN_BODY_LIMIT, config: { auth: false, rateLimit: { bucket: 'auth' } } },
    async (request, reply) => {
      const body = fields(request.body);
      // The browser's existing nonce is kept, so links it asked for earlier still work in it.
      const nonce = nonceOf(request.headers.cookie) ?? newSecret();
      try {
        await opts.magicLink.request(body['email'], {
          nonce,
          locale: localeOf(request.headers['accept-language']),
          returnTo: body['return_to'],
        });
      } catch (err) {
        const form = request.headers['content-type']?.startsWith(
          'application/x-www-form-urlencoded',
        );
        if (form === true && isAppError(err) && err.code === 'validation_failed') {
          return asPage(reply, 422).send(invalidEmailPage());
        }
        throw err;
      }
      return asPage(reply, 202).header('set-cookie', nonceCookie(nonce)).send(sentPage());
    },
  );

  app.get('/login/email/verify', { config: { auth: false } }, async (request, reply) => {
    const { t } = request.query as { t?: unknown };
    if (typeof t !== 'string' || !SECRET_SHAPE.test(t))
      return asPage(reply, 400).send(failedPage());
    const nonce = nonceOf(request.headers.cookie);
    if (nonce === undefined) return asPage(reply, 400).send(otherBrowserPage());
    return asPage(reply, 200).send(confirmPage(t, csrfFor(nonce)));
  });

  app.post(
    '/login/email/verify',
    { bodyLimit: LOGIN_BODY_LIMIT, config: { auth: false, rateLimit: { bucket: 'auth' } } },
    async (request, reply) => {
      const body = fields(request.body);
      const nonce = nonceOf(request.headers.cookie);
      try {
        if (nonce === undefined || !csrfMatches(body['csrf'], nonce)) throw new MagicLinkError();
        const { userId, returnTo } = await opts.magicLink.consume(body['t'], nonce);
        await opts.completer.complete(reply, userId, returnTo);
        if (!reply.sent) return reply.header('cache-control', 'no-store').redirect(returnTo, 303);
        return reply;
      } catch (err) {
        if (!(err instanceof MagicLinkError)) throw err;
        return asPage(reply, 400).send(failedPage());
      }
    },
  );
};
