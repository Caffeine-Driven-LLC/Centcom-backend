/**
 * Projects (B035, CT-API-WORKSPACES):
 *
 * - `GET /v1/workspaces/{id}/projects` (`workspaces:read`, member+): the workspace's projects,
 *   oldest first, CT-PAGE (a cursor works only for the workspace it was made for);
 * - `POST /v1/workspaces/{id}/projects` (`workspaces:write`, member+, users only,
 *   `Idempotency-Key` accepted): 201 with the project and its `ETag`;
 * - `PATCH /v1/projects/{id}` (`workspaces:write`, member+): `If-Match` optional (412 when
 *   stale); 200 with the new `ETag`;
 * - `DELETE /v1/projects/{id}` (`workspaces:write`, admin+): 204.
 *
 * Authorisation is B021's RBAC only. CT-RBAC has no projects row yet, so these routes use the rows
 * with the same roles: member+ is `session.create` ("Create/host session": owner, admin, member)
 * and admin+ is `workspace.update` ("Update workspace settings": owner, admin). `session.create`
 * gives API keys no scope, so an API key cannot list, create or update projects until a
 * contract row exists. A caller who may not know the workspace, or a project of another
 * workspace, gets 404 `not_found`; a member whose role falls short gets 403 (audited).
 *
 * Owns: the HTTP side of projects. Must not: compare roles itself, echo a rejected value, or cache
 * a response in shared caches.
 */
import { isId, type Api } from '@centcom/contracts';
import {
  AppError,
  defineFilters,
  idFilter,
  notFound,
  parsePageQuery,
  type Action,
  type SigningKeys,
} from '@centcom/core';
import type { ProjectRecord } from '@centcom/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope } from '../../plugins/rbac.js';
import { computeEtag, parseIfMatch } from '../me/etag.js';
import { ctxOf, workspaceAccess } from '../workspaces/access.js';
import { parseProjectCreate, parseProjectUpdate } from './input.js';
import { PROJECT_DETAILS, type ProjectService } from './service.js';

/** Options for `projectRoutes`. */
export interface ProjectRouteOptions {
  service: ProjectService;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const PROJECT_ROUTE_DETAILS = Object.freeze({
  usersOnly: 'Only a user can create a project.',
} as const);

/** The RBAC actions these routes ask for (see the module comment). */
export const PROJECT_ACTIONS = Object.freeze({
  read: 'session.create',
  write: 'session.create',
  delete: 'workspace.update',
} as const satisfies Record<string, Action>);

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
/** A cursor is bound to the workspace whose projects it pages. */
const LIST_FILTERS = defineFilters({ workspace: idFilter('wsp') });

/** A project as CT-API-WORKSPACES `Project`. */
export function projectBody(project: ProjectRecord): Api.Project {
  return {
    id: project.id,
    workspace: project.workspaceId,
    name: project.name,
    repo: project.repoRef,
    created_at: project.createdAt.toISOString(),
  };
}

/** Project data: never in shared caches; revalidate with the ETag. */
const privateHeaders = (reply: FastifyReply, version: number): FastifyReply =>
  reply
    .header('etag', computeEtag({ version: String(version) }))
    .header('cache-control', 'private, no-cache');

/**
 * The `:id` project, once the caller may act on it with `action`: 404 for an unknown project and
 * for one whose workspace the caller may not know (the same answer, so neither is confirmed), 403
 * when their role falls short.
 */
async function projectAccess(
  service: ProjectService,
  request: FastifyRequest,
  action: Action,
): Promise<ProjectRecord> {
  const id = (request.params as Record<string, unknown>)['id'];
  const project = isId('prj', id) ? await service.find(id) : null;
  if (project === null) throw notFound(PROJECT_DETAILS.notFound);
  try {
    await workspaceAccess(request, action, {}, project.workspaceId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      throw notFound(PROJECT_DETAILS.notFound);
    }
    throw err;
  }
  return project;
}

export const projectRoutes: FastifyPluginAsync<ProjectRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;
  const { service } = opts;

  app.get(
    '/v1/workspaces/:id/projects',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, PROJECT_ACTIONS.read);
      const query = parsePageQuery(request.query, LIST_SPEC);
      const page = await service.list(workspaceId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: LIST_FILTERS.hash({ workspace: workspaceId }),
        keys: opts.cursorKeys,
        now: clock(),
      });
      reply.header('cache-control', 'private, no-cache');
      return { ...page, data: page.data.map(projectBody) };
    },
  );

  app.post(
    '/v1/workspaces/:id/projects',
    { preHandler: requireScope('workspaces:write'), config: { idempotency: 'accepted' } },
    async (request, reply) => {
      const { actor, workspaceId } = await workspaceAccess(request, PROJECT_ACTIONS.write);
      // A project names the user who made it.
      if (actor.kind !== 'user') {
        throw new AppError('forbidden', { detail: PROJECT_ROUTE_DETAILS.usersOnly });
      }
      const input = parseProjectCreate(request.body);
      const project = await service.create(workspaceId, actor.userId, input, ctxOf(request));
      privateHeaders(reply, project.version);
      return reply.code(201).send(projectBody(project));
    },
  );

  app.patch(
    '/v1/projects/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const project = await projectAccess(service, request, PROJECT_ACTIONS.write);
      const patch = parseProjectUpdate(request.body);
      const updated = await service.update(
        project.id,
        patch,
        parseIfMatch(request.headers['if-match']),
        ctxOf(request),
      );
      privateHeaders(reply, updated.version);
      return projectBody(updated);
    },
  );

  app.delete(
    '/v1/projects/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const project = await projectAccess(service, request, PROJECT_ACTIONS.delete);
      await service.delete(project.id, ctxOf(request));
      return reply.code(204).send();
    },
  );
};
