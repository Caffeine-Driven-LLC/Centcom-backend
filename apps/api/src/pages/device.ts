/**
 * The browser side of the terminal sign-in (B102): where a person types or confirms the code the
 * terminal shows, signs in if they are not, and approves or denies the device.
 *
 * - `GET /device[?user_code=]`: signed out, remembers the code in a short cookie and sends the
 *   visitor to the sign-in page; signed in, shows the entry form or, with a code, what is asking
 *   for access (device name, platform, fingerprint) and the two buttons.
 * - `POST /device`: the entry form; the same as the GET with a code.
 * - `POST /device/approve`, `POST /device/deny`: decide, then one neutral page.
 * - `GET /device/login`: the e-mail form of the magic-link sign-in (`POST /login/email`), asking
 *   to come back to `/device`.
 *
 * Owns: the HTTP side and the markup of these pages. Must not: tell a wrong code from an expired,
 * used or other person's one; accept a form without its CSRF token; log a code or a cookie; cache
 * a page; let a value from a request or a device reach the markup unescaped.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { escapeHtml, isAppError, resolveClientIp, type Logger } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceGrantService, PendingGrant } from '../modules/auth/device/service.js';
import { normaliseUserCode } from '../modules/auth/device/usercode.js';
import { readCookie } from '../modules/auth/web-session/cookies.js';
import type { LoginSessions } from '../modules/auth/web-session/store.js';

/** Where the pages live. */
export const DEVICE_PATH = '/device';
/** The e-mail form for visitors who are not signed in. */
export const DEVICE_LOGIN_PATH = '/device/login';
/** The biggest form body read. */
export const DEVICE_FORM_LIMIT = 4 * 1024;
/** Double-submit CSRF cookie. */
export const CSRF_COOKIE = 'centcom_device_csrf';
/** The code a signed-out visitor came with, kept until they are back from signing in. */
export const CODE_COOKIE = 'centcom_device_code';
/** How long both cookies live: as long as a device code (600 s). */
export const COOKIE_TTL_S = 600;

const CSRF_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Options for `devicePages`. */
export interface DevicePageOptions {
  devices: Pick<DeviceGrantService, 'lookupUserCode' | 'approveDeviceGrant' | 'denyDeviceGrant'>;
  sessions: Pick<LoginSessions, 'getLoginSession'>;
  /** Where signed-out visitors can sign in (the e-mail form's `return_to` value); null: nowhere. */
  returnTo: string | null;
  /** TRUSTED_PROXY_HOPS: proxies whose `X-Forwarded-For` is believed, to find the visitor's address. */
  trustedHops: number;
  /** Mark the cookies `Secure`; false only for http://localhost development. */
  secureCookies: boolean;
  logger?: Logger;
}

/** A whole page with `title` and `body` (already escaped HTML). */
const page = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;

const field = (name: string, value: string): string =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

/** The entry form. */
export const entryPage = (csrf: string): string =>
  page(
    'Sign in to your terminal',
    `<p>Type the code your terminal shows.</p>
<form method="post" action="${DEVICE_PATH}">
${field('csrf', csrf)}
<label>Code <input name="user_code" autocomplete="off" autocapitalize="characters" maxlength="16" required></label>
<button type="submit">Continue</button>
</form>`,
  );

/** What is asking for access, with the two buttons. */
export const confirmPage = (grant: PendingGrant, csrf: string): string =>
  page(
    'Allow this device?',
    `<p>A device is asking to sign in to your Centcom account.</p>
<dl>
<dt>Device</dt><dd>${escapeHtml(grant.deviceName)}</dd>
<dt>Platform</dt><dd>${escapeHtml(grant.platform)}</dd>
<dt>Fingerprint</dt><dd><code>${escapeHtml(grant.fingerprint)}</code></dd>
<dt>Code</dt><dd><code>${escapeHtml(grant.userCode)}</code></dd>
</dl>
<p>Only allow it if your terminal shows the same code and fingerprint.</p>
<form method="post" action="${DEVICE_PATH}/approve">
${field('csrf', csrf)}${field('user_code', grant.userCode)}
<button type="submit">Allow</button>
</form>
<form method="post" action="${DEVICE_PATH}/deny">
${field('csrf', csrf)}${field('user_code', grant.userCode)}
<button type="submit">Deny</button>
</form>`,
  );

/** The one answer for every code that cannot be used. */
export const invalidCodePage = (csrf: string): string =>
  page(
    'That code did not work',
    `<p>The code is not valid or has expired. Check your terminal, or start the sign-in again there.</p>
<form method="post" action="${DEVICE_PATH}">
${field('csrf', csrf)}
<label>Code <input name="user_code" autocomplete="off" autocapitalize="characters" maxlength="16" required></label>
<button type="submit">Try again</button>
</form>`,
  );

/** After a decision. */
export const decidedPage = (approved: boolean): string =>
  page(
    approved ? 'Device allowed' : 'Device denied',
    approved
      ? '<p>You can go back to your terminal. This page can be closed.</p>'
      : '<p>The device was not given access. This page can be closed.</p>',
  );

/** Too many wrong codes. */
export const lockedPage = (): string =>
  page('Too many tries', '<p>Too many codes did not work. Wait a few minutes and try again.</p>');

/** The e-mail form. */
export const loginPage = (returnTo: string): string =>
  page(
    'Sign in',
    `<p>Enter your e-mail address and we will send you a link.</p>
<form method="post" action="/login/email">
${field('return_to', returnTo)}
<label>E-mail <input type="email" name="email" autocomplete="email" required></label>
<button type="submit">Send the link</button>
</form>`,
  );

/** Signing in is not set up on this server. */
export const noLoginPage = (): string =>
  page('Sign in', '<p>Signing in with a browser is not available on this server.</p>');

/** Every page: HTML, never cached, no scripts, forms only to this origin, never framed. */
const asPage = (reply: FastifyReply, status = 200): FastifyReply =>
  reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header(
      'content-security-policy',
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    )
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff');

const cookieHeader = (name: string, value: string, maxAgeS: number, secure: boolean): string =>
  [
    `${name}=${value}`,
    `Path=${DEVICE_PATH}`,
    `Max-Age=${maxAgeS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

const fields = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

/** A user code as typed or carried in a query, or undefined when it cannot be one. */
const codeOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 32) return undefined;
  return normaliseUserCode(value) === null ? undefined : value;
};

export const devicePages: FastifyPluginAsync<DevicePageOptions> = async (app, opts) => {
  // HTML forms post url-encoded bodies; this parser exists only inside these routes.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: DEVICE_FORM_LIMIT },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const PUBLIC = { bodyLimit: DEVICE_FORM_LIMIT, config: { auth: false as const } };
  const LIMITED = {
    bodyLimit: DEVICE_FORM_LIMIT,
    config: { auth: false as const, rateLimit: { bucket: 'auth' as const } },
  };

  /** The CSRF token for this browser: its cookie's, or a new one (set on the reply). */
  const csrfFor = (request: FastifyRequest, reply: FastifyReply): string => {
    const existing = readCookie(request.headers.cookie, CSRF_COOKIE);
    if (existing !== undefined && CSRF_SHAPE.test(existing)) return existing;
    const token = randomBytes(32).toString('base64url');
    void reply.header(
      'set-cookie',
      cookieHeader(CSRF_COOKIE, token, COOKIE_TTL_S, opts.secureCookies),
    );
    return token;
  };

  /** True when the form's token is the cookie's. */
  const csrfHolds = (request: FastifyRequest, given: unknown): boolean => {
    const cookie = readCookie(request.headers.cookie, CSRF_COOKIE);
    return (
      cookie !== undefined &&
      CSRF_SHAPE.test(cookie) &&
      typeof given === 'string' &&
      same(cookie, given)
    );
  };

  const forbidden = (reply: FastifyReply): FastifyReply =>
    asPage(reply, 403).send(
      page(
        'Request refused',
        '<p>This form did not come from this site. Go back and try again.</p>',
      ),
    );

  /** Signed out: keep the code and go sign in (or say there is no way to). */
  const toSignIn = (reply: FastifyReply, code: string | undefined): FastifyReply => {
    if (opts.returnTo === null) return asPage(reply, 503).send(noLoginPage());
    if (code !== undefined) {
      void reply.header(
        'set-cookie',
        cookieHeader(CODE_COOKIE, encodeURIComponent(code), COOKIE_TTL_S, opts.secureCookies),
      );
    }
    return reply.header('cache-control', 'no-store').redirect(DEVICE_LOGIN_PATH, 303);
  };

  /** Looks `code` up for `userId` and renders what the person decides on. */
  const show = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    code: string | undefined,
  ): Promise<FastifyReply> => {
    const csrf = csrfFor(request, reply);
    if (code === undefined) return asPage(reply).send(entryPage(csrf));
    try {
      const grant = await opts.devices.lookupUserCode(code, {
        userId,
        ip: resolveClientIp(request, opts.trustedHops),
      });
      if (grant === null) return asPage(reply, 404).send(invalidCodePage(csrf));
      return asPage(reply).send(confirmPage(grant, csrf));
    } catch (err) {
      if (isAppError(err) && err.code === 'rate_limited')
        return asPage(reply, 429).send(lockedPage());
      throw err;
    }
  };

  const savedCode = (request: FastifyRequest): string | undefined => {
    const raw = readCookie(request.headers.cookie, CODE_COOKIE);
    if (raw === undefined) return undefined;
    try {
      return codeOf(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  };

  app.get(DEVICE_PATH, LIMITED, async (request, reply) => {
    const query = fields(request.query);
    const code = codeOf(query['user_code']) ?? savedCode(request);
    const session = await opts.sessions.getLoginSession(request, reply);
    if (session === null) return toSignIn(reply, code);
    return show(request, reply, session.userId, code);
  });

  app.post(DEVICE_PATH, LIMITED, async (request, reply) => {
    const body = fields(request.body);
    if (!csrfHolds(request, body['csrf'])) return forbidden(reply);
    const code = codeOf(body['user_code']);
    const session = await opts.sessions.getLoginSession(request, reply);
    if (session === null) return toSignIn(reply, code);
    // A code that cannot even be one is looked up as nothing, so it counts like any wrong code.
    return show(
      request,
      reply,
      session.userId,
      code ?? (typeof body['user_code'] === 'string' ? '-' : undefined),
    );
  });

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`${DEVICE_PATH}/${decision}`, LIMITED, async (request, reply) => {
      const body = fields(request.body);
      if (!csrfHolds(request, body['csrf'])) return forbidden(reply);
      const session = await opts.sessions.getLoginSession(request, reply);
      const code = codeOf(body['user_code']);
      if (session === null) return toSignIn(reply, code);
      const csrf = csrfFor(request, reply);
      try {
        if (code === undefined) throw Object.assign(new Error('bad code'), { invalid: true });
        if (decision === 'approve') {
          await opts.devices.approveDeviceGrant(
            code,
            session.userId,
            resolveClientIp(request, opts.trustedHops),
          );
        } else {
          await opts.devices.denyDeviceGrant(
            code,
            session.userId,
            resolveClientIp(request, opts.trustedHops),
          );
        }
      } catch (err) {
        if (isAppError(err) && err.code === 'rate_limited')
          return asPage(reply, 429).send(lockedPage());
        if (
          (isAppError(err) && err.code === 'expired_token') ||
          (err as { invalid?: boolean }).invalid === true
        ) {
          return asPage(reply, 404).send(invalidCodePage(csrf));
        }
        throw err;
      }
      void reply.header('set-cookie', cookieHeader(CODE_COOKIE, '', 0, opts.secureCookies));
      return asPage(reply).send(decidedPage(decision === 'approve'));
    });
  }

  app.get(DEVICE_LOGIN_PATH, PUBLIC, (_request, reply) =>
    opts.returnTo === null
      ? asPage(reply, 503).send(noLoginPage())
      : asPage(reply).send(loginPage(opts.returnTo)),
  );
};
