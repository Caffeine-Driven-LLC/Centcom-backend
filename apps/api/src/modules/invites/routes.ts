/**
 * Invites (B029, CT-API-WORKSPACES):
 *
 * - `POST /v1/workspaces/{id}/invites` (`workspaces:write`, admin+, `Idempotency-Key` required):
 *   201 with the invite, its token and link;
 * - `GET /v1/workspaces/{id}/invites` (`workspaces:read`, admin+): pending invites, CT-PAGE;
 * - `DELETE /v1/invites/{id}` (`workspaces:write`, admin+): 204;
 * - `GET /v1/invites/{token}` (public, the anonymous rate-limit bucket): the preview;
 * - `POST /v1/invites/{token}/accept` (`profile`, users, `Idempotency-Key` accepted): 201 with the
 *   workspace and the new membership;
 * - `PUT /v1/invites/{id}/key-bundle` (`sessions:host`, a session host of the workspace): 204;
 * - `GET /v1/invites/{token}/key-bundle` (`profile`, the user who accepted): the bundle, once.
 *
 * Authorisation is B021's RBAC (`member.invite` for managing invites): outsiders get 404. Logs
 * carry the route template (`/v1/invites/:token`), never a token; the create response's replay
 * copy is kept encrypted (B024 `sensitiveResponse`, so the idempotency plugin needs its
 * `encryptionKey`). The key in an invite link's fragment (`#k=`) never reaches the server: a `k`
 * query parameter is refused. Registering these routes without B030's `seatGate` decorator
 * throws, so the API cannot start without seat checks.
 *
 * Owns: the HTTP side of invites. Must not: return a token but on create, or a key bundle but to
 * the user who accepted.
 */
import { isId, type Api } from '@centcom/contracts';
import { AppError, defineFilters, idFilter, parsePageQuery, type SigningKeys } from '@centcom/core';
import { inviteStatus, type InviteRecord, type WorkspaceStore } from '@centcom/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireScope } from '../../plugins/rbac.js';
import { memberBody } from '../members/routes.js';
import { actorOf, ctxOf, workspaceAccess } from '../workspaces/access.js';
import { workspaceBody } from '../workspaces/routes.js';
import { WORKSPACE_DETAILS } from '../workspaces/service.js';
import { MAX_KEY_BUNDLE_CHARS, parseInviteCreate, parseKeyBundle } from './input.js';
import './ports.js';
import { INVITE_DETAILS, type InviteCtx, type InviteService } from './service.js';

/** Options for `inviteRoutes`. */
export interface InviteRouteOptions {
  service: InviteService;
  /** For the accept answer, the workspace as the new member sees it. */
  workspaces: WorkspaceStore;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for statuses and cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const INVITE_ROUTE_DETAILS = Object.freeze({
  keyInQuery:
    'The key in an invite link stays in the link’s fragment; never send it to the server.',
  usersOnly: 'Only a user can do this.',
  missingSeatGate:
    'inviteRoutes: the seatGate decorator (B030) is missing; invites refuse to run without seat checks',
} as const);

/** Room for a 16 KiB bundle in its JSON body. */
const KEY_BUNDLE_BODY_LIMIT = MAX_KEY_BUNDLE_CHARS + 1024;
const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
/** A cursor is bound to the workspace whose invites it pages. */
const LIST_FILTERS = defineFilters({ workspace: idFilter('wsp') });

/** An invite as CT-API-WORKSPACES `Invite`. */
export function inviteBody(invite: InviteRecord, now: Date): Api.Invite {
  return {
    id: invite.id,
    workspace: invite.workspaceId,
    email: invite.email,
    role: invite.role,
    status: inviteStatus(invite, now),
    share_history: invite.shareHistory,
    created_by: invite.createdBy,
    created_at: invite.createdAt.toISOString(),
    expires_at: invite.expiresAt.toISOString(),
  };
}

/** The calling user's id, or 403 for any other kind of caller (401 without one). */
function userOf(request: FastifyRequest): string {
  const actor = actorOf(request);
  if (actor.kind !== 'user') {
    throw new AppError('forbidden', { detail: INVITE_ROUTE_DETAILS.usersOnly });
  }
  return actor.userId;
}

const inviteCtx = (request: FastifyRequest): InviteCtx => ({
  ...ctxOf(request),
  seatGate: request.server.seatGate,
});

/** The `:id` invite, or 404. */
async function inviteOf(
  options: InviteRouteOptions,
  request: FastifyRequest,
): Promise<InviteRecord> {
  const id = (request.params as Record<string, unknown>)['id'];
  const invite = isId('inv', id) ? await options.service.find(id) : null;
  if (invite === null) throw new AppError('invite_invalid', { detail: INVITE_DETAILS.unknown });
  return invite;
}

export const inviteRoutes: FastifyPluginAsync<InviteRouteOptions> = async (app, opts) => {
  if (!app.hasDecorator('seatGate')) throw new Error(INVITE_ROUTE_DETAILS.missingSeatGate);
  const clock = opts.clock ?? Date.now;
  const { service } = opts;

  // These routes only: the plugin is encapsulated.
  app.addHook('onRequest', async (request) => {
    if (Object.hasOwn(request.query as object, 'k')) {
      throw new AppError('invalid_request', { detail: INVITE_ROUTE_DETAILS.keyInQuery });
    }
  });

  app.post(
    '/v1/workspaces/:id/invites',
    {
      preHandler: requireScope('workspaces:write'),
      // The response carries the token: its replay copy is kept encrypted (B024).
      config: { idempotency: 'required', sensitiveResponse: true },
    },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'member.invite');
      // An invite names the user who made it.
      const creatorId = userOf(request);
      const input = parseInviteCreate(request.body);
      const created = await service.create(workspaceId, creatorId, input, inviteCtx(request));
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        ...inviteBody(created.invite, new Date(clock())),
        token: created.token,
        url: created.url,
      });
    },
  );

  app.get(
    '/v1/workspaces/:id/invites',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'member.invite');
      const query = parsePageQuery(request.query, LIST_SPEC);
      const now = clock();
      const page = await service.list(workspaceId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: LIST_FILTERS.hash({ workspace: workspaceId }),
        keys: opts.cursorKeys,
        now,
      });
      reply.header('cache-control', 'private, no-cache');
      return { ...page, data: page.data.map((invite) => inviteBody(invite, new Date(now))) };
    },
  );

  app.delete(
    '/v1/invites/:id',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const invite = await inviteOf(opts, request);
      await workspaceAccess(request, 'member.invite', {}, invite.workspaceId);
      await service.revoke(invite.id, inviteCtx(request));
      return reply.code(204).send();
    },
  );

  app.get('/v1/invites/:token', { config: { auth: false } }, async (request, reply) => {
    const token = (request.params as Record<string, unknown>)['token'];
    const preview = await service.preview(token);
    reply.header('cache-control', 'no-store');
    return {
      workspace_name: preview.workspaceName,
      inviter_name: preview.inviterName,
      role: preview.role,
      expires_at: preview.expiresAt.toISOString(),
      has_key_bundle: preview.hasKeyBundle,
    };
  });

  app.post(
    '/v1/invites/:token/accept',
    { preHandler: requireScope('profile'), config: { idempotency: 'accepted' } },
    async (request, reply) => {
      const userId = userOf(request);
      const token = (request.params as Record<string, unknown>)['token'];
      const { member, workspaceId } = await service.accept(token, userId, inviteCtx(request));
      const view = await opts.workspaces.findForMember(workspaceId, userId);
      if (view === null) throw new AppError('not_found', { detail: WORKSPACE_DETAILS.notFound });
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        workspace: workspaceBody(view, view.role === 'guest'),
        member: memberBody(member, 'full'),
      });
    },
  );

  app.put(
    '/v1/invites/:id/key-bundle',
    { preHandler: requireScope('sessions:host'), bodyLimit: KEY_BUNDLE_BODY_LIMIT },
    async (request, reply) => {
      const hostId = userOf(request);
      const invite = await inviteOf(opts, request);
      await workspaceAccess(request, 'workspace.read', {}, invite.workspaceId);
      const bundle = parseKeyBundle(request.body);
      await service.putKeyBundle(invite.id, hostId, bundle);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/invites/:token/key-bundle',
    { preHandler: requireScope('profile') },
    async (request, reply) => {
      const userId = userOf(request);
      const token = (request.params as Record<string, unknown>)['token'];
      const bundle = await service.takeKeyBundle(token, userId);
      reply.header('cache-control', 'no-store');
      return { bundle: bundle.toString('base64url') };
    },
  );
};
