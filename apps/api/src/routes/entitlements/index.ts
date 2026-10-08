/**
 * `GET /v1/workspaces/{id}/entitlements` (B069, CT-API-BILLING, `workspaces:read`, member+): the
 * workspace's CT-ENTITLEMENTS object with its `rev` and an `ETag`; `If-None-Match` with that ETag
 * gives 304. A guest gets 403: CT-RBAC shows guests a workspace's id and name only.
 *
 * Authorisation is B021's RBAC only, through B027's `workspaceAccess`: a caller who is not a
 * member, or asks about a deleted workspace, gets 404. Register after the request-context,
 * error-handler, RBAC and audit plugins.
 *
 * Owns: the HTTP side of entitlements. Must not: compare roles itself, or let a shared cache keep
 * a response.
 */
import { AppError, notFound } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import { entitlementsEtag, ifNoneMatchHits } from '../../modules/entitlements/etag.js';
import {
  ENTITLEMENT_DETAILS,
  type EntitlementService,
} from '../../modules/entitlements/service.js';
import { workspaceAccess } from '../../modules/workspaces/index.js';
import { requireScope } from '../../plugins/rbac.js';

/** Options for `entitlementRoutes`. */
export interface EntitlementRouteOptions {
  service: EntitlementService;
}

/** The details of the route's own refusals (GUIDELINES §3.4). */
export const ENTITLEMENT_ROUTE_DETAILS = Object.freeze({
  guests: "A guest cannot see the workspace's entitlements.",
} as const);

export const entitlementRoutes: FastifyPluginAsync<EntitlementRouteOptions> = async (
  app,
  { service },
) => {
  app.get(
    '/v1/workspaces/:id/entitlements',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { workspaceId, limited } = await workspaceAccess(request, 'workspace.read');
      if (limited) throw new AppError('forbidden', { detail: ENTITLEMENT_ROUTE_DETAILS.guests });
      const body = await service.get(workspaceId);
      if (body === null) throw notFound(ENTITLEMENT_DETAILS.notFound);
      const etag = entitlementsEtag(body);
      reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (ifNoneMatchHits(request.headers['if-none-match'], etag)) return reply.code(304).send();
      return body;
    },
  );
};
