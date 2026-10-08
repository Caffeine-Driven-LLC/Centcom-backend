/**
 * `GET /v1/flags` (B083, CT-API-FLAGS): the flags evaluated for the caller, anonymous allowed.
 *
 * - **Who:** without `Authorization` the caller is anonymous. With it, the bearer credential must
 *   be valid (401 `unauthorized`, `token_expired`, `token_invalid`, `token_revoked` or
 *   `device_revoked` otherwise, as everywhere). A user token with scope `profile` gets its
 *   personal set: its `usr_` id for rollouts, its active workspace and plan from the token. Any
 *   other credential (an API key, a token without `profile`) has no user, so it gets what an
 *   anonymous caller gets.
 * - **Client version:** from `User-Agent` (`centcom-cli/1.4.2 (contract/1.0.0; ...)`, CT-VER); any
 *   other header is an unknown version.
 * - **Caching:** `ETag`; `If-None-Match` with the current one is 304 with no body. Anonymous
 *   answers are `public, max-age=30`, authenticated ones `private, max-age=<FLAGS_TTL_S>`, all with
 *   `Vary: Authorization, User-Agent` (the answer depends on both).
 * - Postgres unreadable for over 5 minutes: 503 with `retry_after_s`.
 *
 * Register after the request-context and error-handler plugins (and the auth plugin, which this
 * route opts out of: it authenticates only when a credential is sent).
 *
 * Owns: the HTTP side. Must not: answer anyone else's flags, or require a credential.
 */
import { AppError, isAppError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../modules/auth/tokens/service.js';
import { ifNoneMatchHits } from '../modules/entitlements/etag.js';
import { PLANS, type Plan } from '../modules/flags/definition.js';
import type { EvalContext } from '../modules/flags/evaluate.js';
import type { FlagService } from '../modules/flags/service.js';
import { parseClientVersion } from '../modules/flags/version.js';

/** Options for `flagRoutes`. */
export interface FlagRouteOptions {
  flags: Pick<FlagService, 'answer'>;
  /** The token service's `authenticate` (B017; B019's API keys through its resolvers). */
  authenticate(credential: string): Promise<Principal>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** RFC 6750 `b64token` after a case-insensitive `Bearer` scheme (as the auth plugin reads it). */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

/** The caller's principal when it sent a credential; null when anonymous. */
async function principalOf(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticate: FlagRouteOptions['authenticate'],
): Promise<Principal | null> {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const credential = BEARER.exec(header)?.[1];
  if (credential === undefined) {
    void reply.header('www-authenticate', 'Bearer');
    throw new AppError('unauthorized', {
      detail: 'The Authorization header is not a bearer token.',
    });
  }
  try {
    return await authenticate(credential);
  } catch (err) {
    if (isAppError(err) && err.status === 401) {
      void reply.header('www-authenticate', 'Bearer error="invalid_token"');
    }
    throw err;
  }
}

/** The evaluation context of a request. */
export function contextOf(principal: Principal | null, userAgent: unknown, now: Date): EvalContext {
  const version = parseClientVersion(userAgent);
  const clientVersion =
    version === null
      ? {}
      : {
          clientVersion: `${version.major}.${version.minor}.${version.patch}${version.pre.length > 0 ? `-${version.pre.join('.')}` : ''}`,
        };
  const personal =
    principal !== null &&
    principal.kind === 'user' &&
    principal.userId !== null &&
    principal.scopes.includes('profile');
  if (!personal) return { now, ...clientVersion };
  const plan = principal.claims?.plan;
  return {
    now,
    userId: principal.userId as string,
    ...(principal.workspaceId === null ? {} : { workspaceId: principal.workspaceId }),
    ...((PLANS as readonly unknown[]).includes(plan) ? { plan: plan as Plan } : {}),
    ...clientVersion,
  };
}

export const flagRoutes: FastifyPluginAsync<FlagRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;

  app.get('/v1/flags', { config: { auth: false } }, async (request, reply) => {
    // The answer depends on both, whatever the outcome.
    void reply.header('vary', 'Authorization, User-Agent');
    const principal = await principalOf(request, reply, opts.authenticate);
    const ctx = contextOf(principal, request.headers['user-agent'], new Date(clock()));
    const { body, etag, cacheControl } = await opts.flags.answer(ctx, principal !== null);
    void reply.header('etag', etag).header('cache-control', cacheControl);
    if (ifNoneMatchHits(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return body;
  });
};
