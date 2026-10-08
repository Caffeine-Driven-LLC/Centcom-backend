/**
 * `GET /v1/auth/authorize` (B018, CT-AUTH): the browser authorize endpoint of the authorization
 * code + PKCE flow. Public (no bearer token): the browser's login session cookie says who is
 * signed in. Answers 302 to the registered `redirect_uri` with `code` and `state`, or 302 to the
 * login page with a signed `return_to`; every error is a problem response, never a redirect.
 * Counts in the `auth` rate-limit bucket (20/min/IP). Redirects carry `Cache-Control: no-store`
 * and `Referrer-Policy: no-referrer`, since the code rides in the Location.
 *
 * Owns: the HTTP side. Must not: redirect before the request is checked.
 */
import type { FastifyPluginAsync } from 'fastify';
import { AUTHORIZE_PATH, type Authorizer } from '../../modules/auth/pkce/authorize.js';
import type { LoginSessions } from '../../modules/auth/web-session/store.js';

/** Options for `authorizeRoutes`. */
export interface AuthorizeRouteOptions {
  authorizer: Authorizer;
  sessions: Pick<LoginSessions, 'getLoginSession'>;
}

export const authorizeRoutes: FastifyPluginAsync<AuthorizeRouteOptions> = async (
  app,
  { authorizer, sessions },
) => {
  app.get(
    AUTHORIZE_PATH,
    { config: { auth: false, rateLimit: { bucket: 'auth' } } },
    async (request, reply) => {
      const checked = authorizer.check(request.query);
      const session = await sessions.getLoginSession(request, reply);
      const location =
        session === null
          ? await authorizer.loginRedirect(request.url)
          : await authorizer.codeRedirect(checked, session.userId);
      return reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .redirect(location, 302);
    },
  );
};
