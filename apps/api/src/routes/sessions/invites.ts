/**
 * Session invites (B105, CT-API-SESSIONS, ADR 0002):
 *
 * - `POST /v1/sessions/{id}/invites` (`sessions:host`, the host, `Idempotency-Key` accepted): 201
 *   with the invite, its token and link; one person, one session, editor or viewer, no seat;
 * - `GET /v1/sessions/{id}/invites` (`sessions:host`, the host): the pending invites, CT-PAGE.
 *
 * Accept, preview, revoke and the key bundle are the invite routes of B029 (`/v1/invites/...`),
 * which hand a session invite's token to `SessionInviteService`. A caller who is not the live host
 * of the session gets 404 `session_not_found` (never a hint that the session exists).
 *
 * Owns: the HTTP side of creating and listing. Must not: log a token, or use a seat.
 */
import type { Api } from '@centcom/contracts';
import { defineFilters, idFilter, parsePageQuery, type SigningKeys } from '@centcom/core';
import { sessionInviteStatus, type SessionInviteRecord } from '@centcom/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  parseSessionInviteCreate,
  type SessionInviteService,
} from '../../modules/invites/session-invites.js';
import { callerOf, liveRole, notVisible, sessionIdOf } from './access.js';
import type { SessionRouteStore } from './store.js';

export interface SessionInviteRouteDeps {
  service: SessionInviteService;
  store: Pick<SessionRouteStore, 'standing'>;
  /** The inviter's name for the e-mail. */
  names: { displayName(userId: string): Promise<string> };
  sessions: { get(id: string): Promise<{ name: string } | null> };
  cursorKeys: SigningKeys;
  clock?: () => number;
}

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
const LIST_FILTERS = defineFilters({ session: idFilter('ses') });

/** A session invite as `Invite` (CT-API-WORKSPACES) with `session` set. */
export function sessionInviteBody(invite: SessionInviteRecord, now: Date): Api.Invite {
  return {
    id: invite.id,
    workspace: invite.workspaceId ?? '',
    session: invite.sessionId,
    email: invite.email,
    role: invite.role,
    status: sessionInviteStatus(invite, now),
    share_history: invite.shareHistory,
    created_by: invite.createdBy,
    created_at: invite.createdAt.toISOString(),
    expires_at: invite.expiresAt.toISOString(),
  } as unknown as Api.Invite;
}

export const sessionInviteRoutes: FastifyPluginAsync<SessionInviteRouteDeps> = async (
  app,
  deps,
) => {
  const clock = deps.clock ?? Date.now;

  app.post(
    '/v1/sessions/:id/invites',
    {
      config: {
        auth: { scopes: ['sessions:host'] },
        idempotency: 'accepted',
        sensitiveResponse: true,
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const standing = await deps.store.standing(sid, caller.userId);
      if (standing === null || liveRole(standing) !== 'host') throw notVisible();
      const input = parseSessionInviteCreate(request.body);
      const session = await deps.sessions.get(sid);
      if (session === null) throw notVisible();
      const created = await deps.service.create(
        {
          id: sid,
          workspaceId: standing.session.workspaceId,
          name: session.name,
          state: standing.session.state,
        },
        caller.userId,
        await deps.names.displayName(caller.userId),
        input,
      );
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        ...sessionInviteBody(created.invite, new Date(clock())),
        token: created.token,
        url: created.url,
      });
    },
  );

  app.get(
    '/v1/sessions/:id/invites',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const standing = await deps.store.standing(sid, caller.userId);
      if (standing === null || liveRole(standing) !== 'host') throw notVisible();
      const query = parsePageQuery(request.query, LIST_SPEC);
      const now = clock();
      const page = await deps.service.list(sid, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: LIST_FILTERS.hash({ session: sid }),
        keys: deps.cursorKeys,
        now,
      });
      reply.header('cache-control', 'private, no-cache');
      return { ...page, data: page.data.map((i) => sessionInviteBody(i, new Date(now))) };
    },
  );
};
