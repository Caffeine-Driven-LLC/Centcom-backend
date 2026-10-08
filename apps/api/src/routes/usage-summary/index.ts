/**
 * `GET /v1/workspaces/{id}/usage/summary` (B075, CT-API-BILLING / CT-API-USAGE `UsageSummary`),
 * scope `billing:read`, role member+: the workspace's usage for its current period against its
 * limits (see `UsageSummaryService`).
 *
 * Authorisation is B021's RBAC through `workspaceAccess` (`workspace.read`): a non-member, or a
 * deleted or unknown workspace, gets 404; a guest gets 403 (CT-RBAC shows guests a workspace's id
 * and name only). Register after the request-context, error-handler, auth and RBAC plugins.
 *
 * Owns: the HTTP side. Must not: show another workspace's usage.
 */
import { AppError } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { UsageSummaryService } from '../../modules/usage/reader.js';
import { workspaceAccess } from '../../modules/workspaces/access.js';
import { requireScope } from '../../plugins/rbac.js';

/** Options for `usageSummaryRoutes`. */
export interface UsageSummaryRouteOptions {
  summary: Pick<UsageSummaryService, 'summary'>;
}

/** The details of the route's own refusals (GUIDELINES §3.4). */
export const USAGE_SUMMARY_DETAILS = Object.freeze({
  guests: "A guest cannot see the workspace's usage.",
} as const);

export const usageSummaryRoutes: FastifyPluginAsync<UsageSummaryRouteOptions> = async (
  app,
  { summary },
) => {
  app.get(
    '/v1/workspaces/:id/usage/summary',
    { preHandler: requireScope('billing:read') },
    async (request, reply) => {
      const { workspaceId, limited } = await workspaceAccess(request, 'workspace.read');
      if (limited) throw new AppError('forbidden', { detail: USAGE_SUMMARY_DETAILS.guests });
      const body = await summary.summary(workspaceId);
      reply.header('cache-control', 'private, no-cache');
      return body;
    },
  );
};
