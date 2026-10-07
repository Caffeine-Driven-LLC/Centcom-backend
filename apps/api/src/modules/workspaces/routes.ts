/**
 * `/v1/workspaces` (B027, CT-API-WORKSPACES):
 *
 * - `GET /v1/workspaces` (`workspaces:read`): the caller's workspaces, newest first, CT-PAGE
 *   (`limit` 50 by default, at most 200); a cursor works only for the member it was made for. An
 *   API key's list is its own workspace.
 * - `POST /v1/workspaces` (`workspaces:write`, users only, `Idempotency-Key` accepted): 201 with
 *   the caller as `owner`, an `ETag` and a `Location`.
 * - `GET /v1/workspaces/{id}` (`workspaces:read`, member+): the workspace with its `ETag`; a
 *   guest sees `{id, name}` only (CT-RBAC).
 * - `PATCH /v1/workspaces/{id}` (`workspaces:write`, admin+): needs `If-Match` (400 without it,
 *   412 when stale); 200 with the new `ETag`.
 * - `DELETE /v1/workspaces/{id}` (`workspaces:write`, owner): 204; then every read is a 404.
 *
 * Authorisation is B021's RBAC only. A caller who is not a member of the workspace, or of a
 * deleted one, gets 404 `not_found` whatever they asked, so its existence is never confirmed; a
 * member whose role falls short gets 403 (and the denial is audited). Register after the
 * request-context, error-handler, RBAC and audit plugins (and idempotency, for replays).
 *
 * Owns: the HTTP side of workspaces. Must not: compare roles itself, or cache a response in
 * shared caches.
 */
import type { Api } from '@centcom/contracts';
import {
  AppError,
  defineFilters,
  idFilter,
  notFound,
  parsePageQuery,
  type SigningKeys,
} from '@centcom/core';
import type { WorkspaceView } from '@centcom/db';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireScope } from '../../plugins/rbac.js';
import { computeEtag, parseIfMatch } from '../me/etag.js';
import { actorOf, ctxOf, readerOf, UNAUTHENTICATED_DETAIL, workspaceAccess } from './access.js';
import { parseCreate, parseUpdate } from './input.js';
import { WORKSPACE_DETAILS, type WorkspaceService } from './service.js';

/** Options for `workspaceRoutes`. */
export interface WorkspaceRouteOptions {
  service: WorkspaceService;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const WORKSPACE_ROUTE_DETAILS = Object.freeze({
  unauthenticated: UNAUTHENTICATED_DETAIL,
  usersOnly: 'Only a user can create a workspace.',
  ifMatchRequired: 'If-Match is required: send the ETag of the workspace you read.',
} as const);

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
/** A cursor is bound to the member whose list it pages: another caller's cursor is a 400. */
const LIST_FILTERS = defineFilters({ member: idFilter('usr') });
/** A workspace as CT-API-WORKSPACES `Workspace`; a guest's view is `{id, name}` (CT-RBAC). */
export function workspaceBody(
  view: WorkspaceView,
  limited: boolean,
): Api.Workspace | { id: string; name: string } {
  if (limited) return { id: view.id, name: view.name };
  return {
    id: view.id,
    name: view.name,
    slug: view.slug,
    ...(view.role === null ? {} : { role: view.role }),
    ...(view.ownerId === null ? {} : { owner: view.ownerId }),
    member_count: view.memberCount,
    created_at: view.createdAt.toISOString(),
  };
}

/** Workspace data: never in shared caches; revalidate with the ETag. */
const privateHeaders = (reply: FastifyReply, version: number): FastifyReply =>
  reply
    .header('etag', computeEtag({ version: String(version) }))
    .header('cache-control', 'private, no-cache');

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;
  const { service } = opts;

  app.get(
    '/v1/workspaces',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const reader = readerOf(actorOf(request));
      const query = parsePageQuery(request.query, LIST_SPEC);
      const filterHash = LIST_FILTERS.hash(reader.kind === 'user' ? { member: reader.userId } : {});
      const result = await service.list(reader, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash,
        keys: opts.cursorKeys,
        now: clock(),
      });
      reply.header('cache-control', 'private, no-cache');
      return {
        ...result,
        data: result.data.map((view) => workspaceBody(view, view.role === 'guest')),
      };
    },
  );

  app.post(
    '/v1/workspaces',
    { preHandler: requireScope('workspaces:write'), config: { idempotency: 'accepted' } },
    async (request, reply) => {
      const actor = actorOf(request);
      if (actor.kind !== 'user') {
        throw new AppError('forbidden', { detail: WORKSPACE_ROUTE_DETAILS.usersOnly });
      }
      const input = parseCreate(request.body);
      const view = await service.create(actor.userId, input, ctxOf(request));
      privateHeaders(reply, view.version).header('location', `/v1/workspaces/${view.id}`);
      return reply.code(201).send(workspaceBody(view, false));
    },
  );

  app.get(
    '/v1/workspaces/:id',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { actor, workspaceId, limited } = await workspaceAccess(request, 'workspace.read');
      const view = await service.get(workspaceId, readerOf(actor));
      if (view === null) throw notFound(WORKSPACE_DETAILS.notFound);
      privateHeaders(reply, view.version);
      return workspaceBody(view, limited);
    },
  );

  app.patch(
    '/v1/workspaces/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'workspace.update');
      const ifMatch = parseIfMatch(request.headers['if-match']);
      if (ifMatch === undefined) {
        throw new AppError('invalid_request', { detail: WORKSPACE_ROUTE_DETAILS.ifMatchRequired });
      }
      const update = parseUpdate(request.body, service.extensions);
      await service.update(workspaceId, update, ifMatch, ctxOf(request));
      const view = await service.get(workspaceId, readerOf(actor));
      if (view === null) throw notFound(WORKSPACE_DETAILS.notFound);
      privateHeaders(reply, view.version);
      return workspaceBody(view, false);
    },
  );

  app.delete(
    '/v1/workspaces/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'workspace.delete');
      await service.softDelete(
        workspaceId,
        parseIfMatch(request.headers['if-match']),
        ctxOf(request),
      );
      return reply.code(204).send();
    },
  );
};
