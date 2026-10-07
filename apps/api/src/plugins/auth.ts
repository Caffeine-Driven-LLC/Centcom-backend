/**
 * Authentication plugin (B017): every route authenticates its caller unless it opts out with
 * `config: { auth: false }`. The plugin reads `Authorization: Bearer <credential>`, has the token
 * service turn it into a principal (an access token, or a registered resolver's credential such
 * as a `cen_` API key, B019), checks the scopes the route lists in `config.auth.scopes`, and
 * attaches `request.principal`.
 *
 * Failures: no or malformed header: 401 `unauthorized`; a bad credential: 401 `token_expired`,
 * `token_invalid`, `token_revoked` or `device_revoked` (one body per code, whatever the cause);
 * a missing scope: 403 `forbidden`. 401s carry `WWW-Authenticate: Bearer` (RFC 6750).
 *
 * Owns: authentication of requests. Must not: log or echo a credential, or authorise beyond
 * scopes (roles are B021's).
 */
import { AppError, isAppError } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { Principal, TokenService } from '../modules/auth/tokens/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who is calling; null on routes with `config.auth: false`. */
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    /** `false` for public routes; else the scopes the caller must hold (none beyond authentication by default). */
    auth?: false | { scopes?: readonly string[] };
  }
}

/** Options for `authPlugin`. */
export interface AuthPluginOptions {
  tokens: TokenService;
}

/** RFC 6750 `b64token` after a case-insensitive `Bearer` scheme. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    const auth = request.routeOptions.config.auth;
    // Unmatched routes answer 404 whatever the credential.
    if (auth === false || request.is404) return;
    const match = BEARER.exec(request.headers.authorization ?? '');
    const credential = match?.[1];
    if (credential === undefined) {
      void reply.header('www-authenticate', 'Bearer');
      throw new AppError('unauthorized', { detail: 'A bearer token is required.' });
    }
    let principal: Principal;
    try {
      principal = await opts.tokens.authenticate(credential);
    } catch (err) {
      if (isAppError(err) && err.status === 401)
        void reply.header('www-authenticate', 'Bearer error="invalid_token"');
      throw err;
    }
    const required = auth?.scopes ?? [];
    if (!required.every((scope) => principal.scopes.includes(scope))) {
      throw new AppError('forbidden', {
        detail: 'The credential does not hold a scope this request needs.',
      });
    }
    request.principal = principal;
  });
};

/**
 * Applies to the whole instance (like the error handler). Register it after the request context
 * and error handler plugins and before any route.
 */
export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-auth',
});
