/**
 * `GET /.well-known/jwks.json` (B017, CT-STATUS): the public keys that verify access tokens and
 * relay tickets. Public, cacheable for 5 minutes, which is why a new key is published one cache
 * lifetime before it signs (see modules/auth/tokens/config.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { TokenService } from '../modules/auth/tokens/service.js';

/** How long clients and relays may cache the JWKS, in seconds. */
export const JWKS_MAX_AGE_S = 300;

/** Options for `wellKnownRoutes`. */
export interface WellKnownRouteOptions {
  tokens: TokenService;
}

export const wellKnownRoutes: FastifyPluginAsync<WellKnownRouteOptions> = async (
  app,
  { tokens },
) => {
  app.get('/.well-known/jwks.json', { config: { auth: false } }, async (_request, reply) => {
    void reply.header('cache-control', `public, max-age=${JWKS_MAX_AGE_S}`);
    return tokens.jwks();
  });
};
