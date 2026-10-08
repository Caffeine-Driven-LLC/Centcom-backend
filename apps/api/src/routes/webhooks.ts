/**
 * CT-API-WEBHOOKS (B081), every route with scope `webhooks:write`, owners and admins only (B021
 * `webhook.manage`; others 403, outsiders 404):
 *
 * - `GET /v1/workspaces/{id}/webhooks`: CT-PAGE of endpoints, newest first.
 * - `POST /v1/workspaces/{id}/webhooks` (`Idempotency-Key` required): 201 with the endpoint and its
 *   `secret`, shown this once (a replay answers the same response, kept encrypted: B024
 *   `sensitiveResponse`). A URL that is not https or not public is 422 `webhook_url_invalid`; past
 *   `webhooks_max`, 403 `entitlement_required`.
 * - `GET /v1/webhooks/{id}`: the endpoint, never its secret.
 * - `PATCH /v1/webhooks/{id}`: url, events, enabled; `rotate_secret: true` answers a new `secret`.
 * - `DELETE /v1/webhooks/{id}`: 204.
 * - `POST /v1/webhooks/{id}/test`: sends `webhook.test` once; 202 with the delivery's result.
 * - `GET /v1/webhooks/{id}/deliveries`: the delivery log, CT-PAGE, newest first.
 * - `POST /v1/webhooks/{id}/deliveries/{dlv}/redeliver`: queues an attempt now; 202.
 *
 * Register after the request-context, error-handler, auth, RBAC, audit and idempotency plugins.
 *
 * Owns: the HTTP side. Must not: return a secret except in the create and rotate responses.
 */
import { defineFilters, idFilter, parsePageQuery, type SigningKeys } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { EndpointRecord } from '../modules/webhooks/repository.js';
import type { WebhookService } from '../modules/webhooks/service.js';
import { ctxOf, workspaceAccess } from '../modules/workspaces/access.js';
import { requireScope } from '../plugins/rbac.js';

/** Options for `webhookRoutes`. */
export interface WebhookRouteOptions {
  service: WebhookService;
  /** CURSOR_SIGNING_KEYS (B025). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

const SCOPE = requireScope('webhooks:write');
const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
const ENDPOINT_CURSOR = defineFilters({ workspace: idFilter('wsp') });
const DELIVERY_CURSOR = defineFilters({ webhook: idFilter('whk') });

export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;
  const { service } = opts;

  /** The endpoint of the route's `:id`, if the caller may manage its workspace (else 404/403). */
  const endpointOf = async (request: FastifyRequest): Promise<EndpointRecord> => {
    const endpoint = await service.find((request.params as Record<string, unknown>)['id']);
    await workspaceAccess(request, 'webhook.manage', {}, endpoint.workspaceId);
    return endpoint;
  };

  const page = (request: FastifyRequest, hash: string) => {
    const query = parsePageQuery(request.query, LIST_SPEC);
    return {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      sort: query.sort,
      filterHash: hash,
      keys: opts.cursorKeys,
      now: clock(),
    };
  };

  app.get('/v1/workspaces/:id/webhooks', { preHandler: SCOPE }, async (request, reply) => {
    const { workspaceId } = await workspaceAccess(request, 'webhook.manage');
    reply.header('cache-control', 'private, no-cache');
    return service.list(
      workspaceId,
      page(request, ENDPOINT_CURSOR.hash({ workspace: workspaceId })),
    );
  });

  app.post(
    '/v1/workspaces/:id/webhooks',
    { preHandler: SCOPE, config: { idempotency: 'required', sensitiveResponse: true } },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'webhook.manage');
      const created = await service.create(workspaceId, request.body, ctxOf(request));
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(created);
    },
  );

  app.get('/v1/webhooks/:id', { preHandler: SCOPE }, async (request, reply) => {
    const endpoint = await endpointOf(request);
    reply.header('cache-control', 'private, no-cache');
    return service.view(endpoint);
  });

  app.patch('/v1/webhooks/:id', { preHandler: SCOPE }, async (request, reply) => {
    const endpoint = await endpointOf(request);
    const updated = await service.update(endpoint, request.body, ctxOf(request));
    reply.header('cache-control', 'no-store');
    return updated;
  });

  app.delete('/v1/webhooks/:id', { preHandler: SCOPE }, async (request, reply) => {
    const endpoint = await endpointOf(request);
    await service.remove(endpoint, ctxOf(request));
    return reply.code(204).send();
  });

  app.post(
    '/v1/webhooks/:id/test',
    { preHandler: SCOPE, config: { idempotency: 'accepted' } },
    async (request, reply) => {
      const endpoint = await endpointOf(request);
      return reply.code(202).send(await service.test(endpoint));
    },
  );

  app.get('/v1/webhooks/:id/deliveries', { preHandler: SCOPE }, async (request, reply) => {
    const endpoint = await endpointOf(request);
    reply.header('cache-control', 'private, no-cache');
    return service.deliveries(
      endpoint,
      page(request, DELIVERY_CURSOR.hash({ webhook: endpoint.id })),
    );
  });

  app.post(
    '/v1/webhooks/:id/deliveries/:dlv/redeliver',
    { preHandler: SCOPE, config: { idempotency: 'accepted' } },
    async (request, reply) => {
      const endpoint = await endpointOf(request);
      const dlv = (request.params as Record<string, unknown>)['dlv'];
      return reply.code(202).send(await service.redeliver(endpoint, dlv));
    },
  );
};
