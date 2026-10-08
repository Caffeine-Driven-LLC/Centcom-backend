/**
 * The audit log API (B082, CT-API-AUDIT), scope `audit:read`, owners and admins:
 *
 * - `GET /v1/workspaces/{id}/audit?actor=&action=&from=&to=&limit=&cursor=`: CT-PAGE of
 *   `AuditEvent`, newest first, within the plan's `audit_log_days`.
 * - `POST /v1/workspaces/{id}/audit/exports` (`Idempotency-Key` accepted): 202 with the
 *   `AuditExport`, pending, and `Location` its status URL. Body `{format, actor?, action?, from?,
 *   to?, gzip?}`.
 * - `GET /v1/workspaces/{id}/audit/exports/{exp}`: the export's status, and a download URL once it
 *   is ready.
 *
 * Authorisation is B021's RBAC through `workspaceAccess` (`audit.read`): a non-member, another
 * workspace's API key, or a deleted or unknown workspace gets 404; a member, guest or billing role
 * 403 `forbidden` (audited, CT-RBAC rule 6); an API key without `audit:read` 403. Then the plan:
 * `audit_log_days = 0` is 403 `entitlement_required` for the list and new exports. Bad filters
 * are 422 (`from` after `to` at `/from`); a cursor from other filters or another workspace is 400
 * `cursor_invalid`. Register after the request-context, error-handler, idempotency, RBAC and audit
 * plugins.
 *
 * Owns: the HTTP side. Must not: let anyone below admin read the log, or audit a read.
 */
import { isId } from '@centcom/contracts';
import { parsePageQuery, type AuditActor } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { parseExportBody, parseListFilters } from '../modules/audit-api/filters.js';
import type { AuditApiService } from '../modules/audit-api/service.js';
import { AUDIT_SORT } from '../modules/audit-api/repository.js';
import { actorOf, workspaceAccess } from '../modules/workspaces/access.js';
import { rbacAuditActor } from '../plugins/audit.js';
import { requireScope } from '../plugins/rbac.js';

/** Options for `auditRoutes`. */
export interface AuditRouteOptions {
  audit: Pick<AuditApiService, 'list' | 'createExport' | 'getExport'>;
}

/** The largest export request body, in bytes. */
export const AUDIT_EXPORT_BODY_LIMIT = 4096;

const LIST_SPEC = { sorts: [AUDIT_SORT], defaultSort: AUDIT_SORT } as const;
const AUDIT_READ = requireScope('audit:read');

/** Who the request acts as, for the export's audit event. */
function auditActor(request: FastifyRequest): AuditActor {
  const actor = rbacAuditActor(request);
  if (actor !== null) return actor;
  const fallback = actorOf(request);
  return fallback.kind === 'user'
    ? { type: 'user', id: fallback.userId }
    : { type: 'api_key', id: fallback.keyId };
}

export const auditRoutes: FastifyPluginAsync<AuditRouteOptions> = async (app, { audit }) => {
  app.get('/v1/workspaces/:id/audit', { preHandler: AUDIT_READ }, async (request, reply) => {
    const { workspaceId } = await workspaceAccess(request, 'audit.read');
    const filters = parseListFilters(request.query);
    const query = parsePageQuery(request.query, LIST_SPEC);
    const page = await audit.list(workspaceId, {
      filters,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    reply.header('cache-control', 'private, no-store');
    return page;
  });

  app.post(
    '/v1/workspaces/:id/audit/exports',
    {
      preHandler: AUDIT_READ,
      bodyLimit: AUDIT_EXPORT_BODY_LIMIT,
      config: { idempotency: 'accepted' },
    },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'audit.read');
      const body = parseExportBody(request.body);
      const created = await audit.createExport(workspaceId, body, {
        actor: auditActor(request),
        ...(isId('req', request.id) ? { requestId: request.id } : {}),
      });
      reply
        .code(202)
        .header('location', `/v1/workspaces/${workspaceId}/audit/exports/${created.id}`)
        .header('cache-control', 'no-store');
      return created;
    },
  );

  app.get(
    '/v1/workspaces/:id/audit/exports/:exp',
    { preHandler: AUDIT_READ },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'audit.read');
      const exp = String((request.params as Record<string, unknown>)['exp'] ?? '');
      const body = await audit.getExport(workspaceId, exp);
      reply.header('cache-control', 'private, no-store');
      return body;
    },
  );
};
