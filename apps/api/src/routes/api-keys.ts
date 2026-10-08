/**
 * `/v1/api-keys` (B019, CT-API-ACCOUNTS), every route with scope `workspaces:write`:
 *
 * - `POST /v1/api-keys` (users only, `Idempotency-Key` accepted): 201 with the key's record and
 *   its `secret`, the only time it is shown; the replay copy is kept encrypted (B024
 *   `sensitiveResponse`).
 * - `GET /v1/api-keys?workspace=&limit=&cursor=`: CT-PAGE, newest first. With `workspace`, an
 *   owner or admin sees every key of the workspace and a member their own; without it, a user's
 *   own keys in every workspace.
 * - `DELETE /v1/api-keys/{id}`: 204, also for a key already revoked.
 *
 * Authorisation is B021's RBAC (`apikey.manage.any` / `apikey.manage.own`): outsiders get 404,
 * and API keys cannot manage keys (403). Register after the request-context, error-handler, auth,
 * RBAC, audit and idempotency plugins.
 *
 * Owns: the HTTP side of API keys. Must not: return a secret or a hash but in the create response.
 */
import { isId, type Api } from '@centcom/contracts';
import {
  AppError,
  defineFilters,
  idFilter,
  notFound,
  parsePageQuery,
  type Actor,
  type SigningKeys,
} from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiKeyFilter, ApiKeyRecord } from '../modules/apikeys/repo.js';
import {
  API_KEY_DETAILS,
  parseApiKeyInput,
  type ApiKeyService,
} from '../modules/apikeys/service.js';
import { actorOf, ctxOf, workspaceAccess } from '../modules/workspaces/access.js';
import { requireScope } from '../plugins/rbac.js';

/** Options for `apiKeyRoutes`. */
export interface ApiKeyRouteOptions {
  service: ApiKeyService;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals. */
export const API_KEY_ROUTE_DETAILS = Object.freeze({
  usersOnly: 'Only a user can manage API keys.',
});

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
const QUERY_FILTERS = defineFilters({ workspace: idFilter('wsp') });
/** A cursor is bound to the workspace and the key owner it pages. */
const CURSOR_FILTERS = defineFilters({ workspace: idFilter('wsp'), owner: idFilter('usr') });

/** A key as CT-API-ACCOUNTS `ApiKey`: never the key or its hash. */
export function apiKeyBody(key: ApiKeyRecord): Api.ApiKey {
  return {
    id: key.id,
    workspace: key.workspaceId,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes as Api.ApiKey['scopes'],
    created_by: key.createdBy,
    created_at: key.createdAt.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

/** The calling user, or 403 for an API key (keys do not manage keys). */
function userOf(actor: Actor): Extract<Actor, { kind: 'user' }> {
  if (actor.kind !== 'user') {
    throw new AppError('forbidden', { detail: API_KEY_ROUTE_DETAILS.usersOnly });
  }
  return actor;
}

export const apiKeyRoutes: FastifyPluginAsync<ApiKeyRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;
  const { service } = opts;

  app.post(
    '/v1/api-keys',
    {
      preHandler: requireScope('workspaces:write'),
      // The response carries the secret: its replay copy is kept encrypted (B024).
      config: { idempotency: 'accepted', sensitiveResponse: true },
    },
    async (request, reply) => {
      const input = parseApiKeyInput(request.body, service.now());
      const actor = actorOf(request);
      // An API key is refused by RBAC here (403), as keys do not manage keys.
      const ownerUserId = actor.kind === 'user' ? actor.userId : '';
      await workspaceAccess(request, 'apikey.manage.own', { ownerUserId }, input.workspaceId);
      const user = userOf(actor);
      const { authorizer } = request.server.rbac;
      const created = await service.create(
        input,
        {
          userId: user.userId,
          scopes: user.scopes,
          may: async (action) =>
            (await authorizer.decide(user, action, { workspaceId: input.workspaceId })).allow,
        },
        ctxOf(request),
      );
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ ...apiKeyBody(created.record), secret: created.key });
    },
  );

  app.get(
    '/v1/api-keys',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const actor = actorOf(request);
      const { workspace } = QUERY_FILTERS.parse(request.query);
      const query = parsePageQuery(request.query, LIST_SPEC);
      let filter: ApiKeyFilter;
      if (workspace === undefined) {
        filter = { createdBy: userOf(actor).userId };
      } else {
        const ownerUserId = actor.kind === 'user' ? actor.userId : '';
        await workspaceAccess(request, 'apikey.manage.own', { ownerUserId }, workspace);
        const user = userOf(actor);
        const any = await request.server.rbac.authorizer.decide(user, 'apikey.manage.any', {
          workspaceId: workspace,
        });
        filter = any.allow
          ? { workspaceId: workspace }
          : { workspaceId: workspace, createdBy: user.userId };
      }
      const page = await service.list(filter, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: CURSOR_FILTERS.hash({
          ...(filter.workspaceId === undefined ? {} : { workspace: filter.workspaceId }),
          ...(filter.createdBy === undefined ? {} : { owner: filter.createdBy }),
        }),
        keys: opts.cursorKeys,
        now: clock(),
      });
      reply.header('cache-control', 'private, no-cache');
      return { ...page, data: page.data.map(apiKeyBody) };
    },
  );

  app.delete(
    '/v1/api-keys/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const id = (request.params as Record<string, unknown>)['id'];
      const key = isId('key', id) ? await service.find(id) : null;
      if (key === null) throw notFound(API_KEY_DETAILS.notFound);
      await workspaceAccess(
        request,
        'apikey.manage.own',
        { ownerUserId: key.createdBy },
        key.workspaceId,
      );
      await service.revoke(key.id, ctxOf(request));
      return reply.code(204).send();
    },
  );
};
