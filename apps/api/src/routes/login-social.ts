/**
 * Browser routes of social login (B015, outside the /v1 contract):
 *
 * - `GET /login/{github|google}?return_to=` sets the signed state cookie and answers 302 to the
 *   provider;
 * - `GET /login/{github|google}/callback?code=&state=` checks the callback against the cookie,
 *   signs the user in and hands over to the `LoginCompleter` (the web login session, B018), which
 *   ends with a 303 to `return_to`.
 *
 * A failed login gets a plain page with a generic message (400, or 502 when the provider was down
 * or slow) and one `auth.social_login_failed` line naming the provider and the reason; codes,
 * tokens and e-mail addresses are never logged. A provider that is not configured answers 404.
 *
 * Owns: the HTTP side of social login. Must not: redirect anywhere but the provider or an
 * allow-listed `return_to`, or let a response be cached.
 */
import { notFound, type Logger } from '@centcom/core';
import type { IdentityProvider } from '@centcom/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  clearStateCookieHeader,
  readCookie,
  STATE_COOKIE,
  stateCookieHeader,
} from '../modules/auth/social/oauth-state.js';
import { SocialLoginError, type SocialLoginFailure } from '../modules/auth/social/provider.js';
import { isProvider, type SocialLoginService } from '../modules/auth/social/service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `false` for public routes (the B017 auth plugin reads it); else the scopes the caller must hold. */
    auth?: false | { scopes?: readonly string[] };
  }
}

/** Finishes a browser login once the user is known (shared with B014; B018 wires the web session). */
export interface LoginCompleter {
  /** Signs `userId` in for this browser and answers (normally 303 to `returnTo`). */
  complete(reply: FastifyReply, userId: string, returnTo: string): Promise<void>;
}

/** Options for `socialLoginRoutes`. */
export interface SocialLoginRouteOptions {
  social: SocialLoginService;
  completer: LoginCompleter;
  logger: Logger;
  /** Mark the state cookie `Secure`; default true (turn off only for http://localhost development). */
  secureCookies?: boolean;
}

const LABEL: Record<IdentityProvider, string> = { github: 'GitHub', google: 'Google' };

/** What each failure tells the user: never why a check failed, only what they can do. */
function message(reason: SocialLoginFailure, provider: IdentityProvider): string {
  if (reason === 'no_verified_email') {
    return `Your ${LABEL[provider]} account has no verified e-mail address we can use. Verify one with ${LABEL[provider]}, then try again.`;
  }
  if (reason === 'provider')
    return `${LABEL[provider]} did not answer in time. Please try again in a moment.`;
  return 'Sign-in did not complete. Please start again.';
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

/** The plain page a failed login gets. */
export function errorPage(text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><h1>Sign-in failed</h1><p>${escapeHtml(text)}</p></body></html>`;
}

export const socialLoginRoutes: FastifyPluginAsync<SocialLoginRouteOptions> = async (app, opts) => {
  const secure = opts.secureCookies ?? true;

  const providerOf = (params: unknown): IdentityProvider => {
    const provider = (params as { provider?: unknown }).provider;
    if (!isProvider(provider) || !opts.social.enabled(provider)) throw notFound();
    return provider;
  };

  app.get('/login/:provider', { config: { auth: false } }, async (request, reply) => {
    const provider = providerOf(request.params);
    const { return_to: returnTo } = request.query as { return_to?: unknown };
    const { redirect, stateCookie } = await opts.social.begin(provider, returnTo);
    return reply
      .header('set-cookie', stateCookieHeader(stateCookie, secure))
      .header('cache-control', 'no-store')
      .redirect(redirect, 302);
  });

  app.get('/login/:provider/callback', { config: { auth: false } }, async (request, reply) => {
    const provider = providerOf(request.params);
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    void reply
      .header('set-cookie', clearStateCookieHeader(secure))
      .header('cache-control', 'no-store');
    try {
      const { userId, returnTo, created } = await opts.social.complete(
        provider,
        query,
        readCookie(request.headers.cookie, STATE_COOKIE),
      );
      opts.logger.info({ provider, created }, 'auth.social_login');
      await opts.completer.complete(reply, userId, returnTo);
      if (!reply.sent) return reply.redirect(returnTo, 303);
      return reply;
    } catch (err) {
      if (!(err instanceof SocialLoginError)) throw err;
      const status = err.reason === 'provider' ? 502 : 400;
      opts.logger.warn({ provider, reason: err.reason, status }, 'auth.social_login_failed');
      return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'")
        .send(errorPage(message(err.reason, provider)));
    }
  });
};
