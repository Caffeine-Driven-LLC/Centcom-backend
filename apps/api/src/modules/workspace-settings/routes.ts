/**
 * `/v1/workspaces/{id}/settings` (B034, CT-API-WORKSPACES):
 *
 * - `GET` (`workspaces:read`, member+): the settings with their `ETag` (`"s<version>"`). A guest
 *   gets 403: CT-RBAC shows guests a workspace's id and name only.
 * - `PATCH` (`workspaces:write`, admin+): needs `If-Match` (400 without it, 412 when stale); 200
 *   with the settings and the new `ETag`.
 *
 * Authorisation is B021's RBAC only, through B027's `workspaceAccess`: a caller who is not a
 * member, or asks about a deleted workspace, gets 404; a member whose role falls short gets 403
 * (audited). Register after the request-context, error-handler, RBAC and audit plugins.
 *
 * Owns: the HTTP side of settings. Must not: compare roles itself, or let a shared cache keep a
 * response.
 */
import { AppError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireScope } from '../../plugins/rbac.js';
import { ctxOf, workspaceAccess } from '../workspaces/index.js';
import { parseSettingsIfMatch } from './etag.js';
import { parseSettingsPatch } from './input.js';
import type { SettingsView, WorkspaceSettingsService } from './service.js';

/** Options for `workspaceSettingsRoutes`. */
export interface WorkspaceSettingsRouteOptions {
  service: WorkspaceSettingsService;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const SETTINGS_ROUTE_DETAILS = Object.freeze({
  guests: "A guest cannot see the workspace's settings.",
  ifMatchRequired: 'If-Match is required: send the ETag of the settings you read.',
} as const);

const send = (reply: FastifyReply, settings: SettingsView): SettingsView['settings'] => {
  reply.header('etag', settings.etag).header('cache-control', 'private, no-cache');
  return settings.settings;
};

export const workspaceSettingsRoutes: FastifyPluginAsync<WorkspaceSettingsRouteOptions> = async (
  app,
  { service },
) => {
  app.get(
    '/v1/workspaces/:id/settings',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { workspaceId, limited } = await workspaceAccess(request, 'workspace.read');
      if (limited) throw new AppError('forbidden', { detail: SETTINGS_ROUTE_DETAILS.guests });
      return send(reply, await service.get(workspaceId));
    },
  );

  app.patch(
    '/v1/workspaces/:id/settings',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'workspace.update');
      const ifMatch = parseSettingsIfMatch(request.headers['if-match']);
      if (ifMatch === undefined) {
        throw new AppError('invalid_request', { detail: SETTINGS_ROUTE_DETAILS.ifMatchRequired });
      }
      const patch = parseSettingsPatch(request.body);
      return send(reply, await service.update(workspaceId, patch, ifMatch, ctxOf(request)));
    },
  );
};
