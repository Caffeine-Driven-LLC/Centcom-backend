/**
 * `/v1/push/subscriptions` (B064, CT-API-NOTIFY), scope `profile`, users only:
 *
 * - `POST /v1/push/subscriptions` (`Idempotency-Key` accepted, B024): registers a web-push
 *   endpoint or an APNs/FCM token for the caller and answers 201 with the subscription (`id`,
 *   `kind`, `device`, `created_at`; never the endpoint, token or keys). The same endpoint/token
 *   again answers 201 with the same subscription. A bad field is 422 with its pointer; an 11th
 *   subscription is 409.
 * - `DELETE /v1/push/subscriptions/{id}`: 204; another user's or an unknown one is 404.
 *
 * An API key is 403: machine principals have no push subscriptions.
 *
 * Owns: the HTTP side. Must not: echo an endpoint, token or key, in a body or a log.
 */
import { AppError, notFound } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  parseRegistration,
  PUSH_DETAILS,
  type PushRegistry,
} from '../../modules/notifications/push/registry.js';

/** Options for `pushRoutes`. */
export interface PushRouteOptions {
  registry: Pick<PushRegistry, 'register' | 'remove'>;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const PUSH_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a user has push subscriptions; API keys cannot use these routes.',
} as const);

function userOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: PUSH_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: PUSH_ROUTE_DETAILS.usersOnly });
  }
  return principal.userId;
}

export const pushRoutes: FastifyPluginAsync<PushRouteOptions> = async (app, { registry }) => {
  app.post(
    '/v1/push/subscriptions',
    { config: { auth: { scopes: ['profile'] }, idempotency: 'accepted' } },
    async (request, reply) => {
      const userId = userOf(request);
      const { subscription } = await registry.register(userId, parseRegistration(request.body));
      return reply.code(201).header('cache-control', 'no-store').send(subscription);
    },
  );

  app.delete(
    '/v1/push/subscriptions/:id',
    { config: { auth: { scopes: ['profile'] } } },
    async (request, reply) => {
      const userId = userOf(request);
      const id = String((request.params as Record<string, unknown>)['id'] ?? '');
      if (!(await registry.remove(userId, id))) throw notFound(PUSH_DETAILS.notFound);
      return reply.code(204).send();
    },
  );
};
