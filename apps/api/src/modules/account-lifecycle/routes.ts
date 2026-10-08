/**
 * Account deletion and data export routes (B026, CT-API-ACCOUNTS), scope `profile`, users only:
 *
 * - `DELETE /v1/me` → 202 `AccountDeletion` `{status: 'pending_deletion', scheduled_for,
 *   grace_days: 30}` with `Location: /v1/me` (whose `deletion_scheduled_for` then shows the
 *   deadline); 409 `conflict` for the only owner of a workspace with other members.
 * - `POST /v1/me/restore` → 200 `User`; 409 with no deletion pending, 410 `gone` after the deadline.
 * - `POST /v1/me/export` (`Idempotency-Key` accepted) → 202 `DataExport` (pending) with `Location`
 *   its status URL; 429 `rate_limited` with `Retry-After` within 24 h of the last export.
 * - `GET /v1/me/export/{id}` → 200 `DataExport`, with `download_url` once ready; another user's
 *   export, or an id that is not one, is 404.
 *
 * No caller is 401 (the auth plugin's token errors, such as `device_revoked`, come first). An API
 * key, or a token without `profile`, is 403: machine principals are not users. Every answer is
 * `Cache-Control: no-store` (a download URL is a bearer credential for 15 minutes). Register after
 * the request-context, error-handler, auth and idempotency plugins.
 *
 * Owns: the HTTP side. Must not: log or cache a download URL, or put the export in a response.
 */
import { isId, type Api } from '@centcom/contracts';
import { AppError, hasScope } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DELETION_GRACE_MS, type AccountLifecycleService, type RequestCtx } from './service.js';

/** Options for `accountLifecycleRoutes`. */
export interface AccountLifecycleRouteOptions {
  service: Pick<
    AccountLifecycleService,
    'requestDeletion' | 'restore' | 'requestExport' | 'getExport'
  >;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const ACCOUNT_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a user has an account; API keys cannot use these routes.',
  scope: 'The credential does not hold a scope this request needs.',
} as const);

/** The largest request body these routes read, in bytes (they read none). */
export const ACCOUNT_BODY_LIMIT = 1024;

/** CT-API-ACCOUNTS' grace period, in days. */
export const GRACE_DAYS = Math.round(DELETION_GRACE_MS / (24 * 60 * 60 * 1000));

/** The calling user: 401 without a caller, 403 for an API key or a missing `profile` scope. */
function userOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: ACCOUNT_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: ACCOUNT_ROUTE_DETAILS.usersOnly });
  }
  if (!hasScope(principal, 'profile')) {
    throw new AppError('forbidden', { detail: ACCOUNT_ROUTE_DETAILS.scope });
  }
  return principal.userId;
}

const ctxOf = (request: FastifyRequest): RequestCtx =>
  isId('req', request.id) ? { requestId: request.id } : {};

const noStore = (reply: FastifyReply): FastifyReply => reply.header('cache-control', 'no-store');

export const accountLifecycleRoutes: FastifyPluginAsync<AccountLifecycleRouteOptions> = async (
  app,
  { service },
) => {
  app.delete(
    '/v1/me',
    { config: { auth: { scopes: ['profile'] } }, bodyLimit: ACCOUNT_BODY_LIMIT },
    async (request, reply) => {
      const userId = userOf(request);
      const { scheduledFor } = await service.requestDeletion(userId, ctxOf(request));
      noStore(reply).code(202).header('location', '/v1/me');
      const body: Api.AccountDeletion = {
        status: 'pending_deletion',
        scheduled_for: scheduledFor,
        grace_days: GRACE_DAYS,
      };
      return body;
    },
  );

  app.post(
    '/v1/me/restore',
    { config: { auth: { scopes: ['profile'] } }, bodyLimit: ACCOUNT_BODY_LIMIT },
    async (request, reply) => {
      const userId = userOf(request);
      const user = await service.restore(userId, ctxOf(request));
      noStore(reply);
      return user;
    },
  );

  app.post(
    '/v1/me/export',
    {
      config: { auth: { scopes: ['profile'] }, idempotency: 'accepted' },
      bodyLimit: ACCOUNT_BODY_LIMIT,
    },
    async (request, reply) => {
      const userId = userOf(request);
      const created = await service.requestExport(userId, ctxOf(request));
      noStore(reply).code(202).header('location', `/v1/me/export/${created.id}`);
      return created.view;
    },
  );

  app.get(
    '/v1/me/export/:id',
    { config: { auth: { scopes: ['profile'] } } },
    async (request, reply) => {
      const userId = userOf(request);
      const id = String((request.params as Record<string, unknown>)['id'] ?? '');
      const view = await service.getExport(userId, id);
      noStore(reply);
      return view;
    },
  );
};
