/**
 * Share-link routes (B068, CT-API-SESSIONS):
 *
 * | Route                                          | Scope           | Who       | Answer                    |
 * | ---------------------------------------------- | --------------- | --------- | ------------------------- |
 * | `POST /v1/sessions/{id}/share-links`           | `sessions:host` | the host  | 201 `ShareLink` + max_uses |
 * | `DELETE /v1/sessions/{id}/share-links/{token}` | `sessions:host` | the host  | 204                       |
 * | `POST /v1/share-links/{token}/join`            | none (public)   | anyone    | 200 `JoinToken` (viewer)  |
 * | `GET /v1/share-links/{token}/members`          | none (public)   | anyone    | 200 `SessionMemberPage` (B104) |
 *
 * `Idempotency-Key` is accepted on create (a replay answers the same link). Create and join
 * answers are `Cache-Control: no-store`: they carry a token or a ticket. The rules are
 * `ShareLinkService`'s; `standingOf(store)` reads the caller's standing from B054's route store,
 * with B054's role cap. An API key is refused as on every session route.
 *
 * Owns: the HTTP surface. Must not: log a token or a ticket (paths with a token are not logged by
 * the handlers; the request log carries the route template).
 */
import { createHash } from 'node:crypto';
import type { Api } from '@centcom/contracts';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  parsePageQuery,
  type SigningKeys,
} from '@centcom/core';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  HostStanding,
  RouteAudit,
  ShareLinkService,
} from '../../modules/share-links/service.js';
import { callerOf, liveRole, memberBody } from '../sessions/access.js';
import type { SessionRouteStore } from '../sessions/store.js';

/** What the routes need. */
export interface ShareLinkRouteDeps {
  service: Pick<ShareLinkService, 'create' | 'revoke' | 'join' | 'membersAccess'>;
  /** B104: the live members of a session (B054's route store). */
  members: Pick<SessionRouteStore, 'members'>;
  /** CURSOR_SIGNING_KEYS (B025), for the guest's members page. */
  cursorKeys: SigningKeys;
  clock?: () => number;
}

/** The caller's standing in a session, from B054's route store (the service's `standing`). */
export function standingOf(
  store: Pick<SessionRouteStore, 'standing'>,
): (sessionId: string, userId: string) => Promise<HostStanding | null> {
  return async (sessionId, userId) => {
    const standing = await store.standing(sessionId, userId);
    if (standing === null) return null;
    const role = liveRole(standing);
    return {
      session: {
        id: standing.session.id,
        workspaceId: standing.session.workspaceId,
        state: standing.session.state,
      },
      role,
      memberId: role === null ? null : (standing.member?.id ?? null),
      visible: role !== null || standing.workspaceRole !== null,
    };
  };
}

const NO_STORE = 'no-store';

/** A member as a guest sees it: the member's view without the user id. */
const guestView = (m: Api.SessionMember): Api.SessionMember => {
  const copy: Api.SessionMember = { ...m };
  delete copy.user;
  return copy;
};
const GUEST_SORT = 'join_order';
const GUEST_LIST_SPEC = { sorts: [GUEST_SORT], defaultSort: GUEST_SORT } as const;

/** The route's audit, through B036's plugin. */
const auditOf =
  (request: FastifyRequest): RouteAudit =>
  (input) => {
    request.audit.detached(input);
  };

const param = (request: FastifyRequest, name: string): string => {
  const value = (request.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
};

const plugin: FastifyPluginAsync<ShareLinkRouteDeps> = async (app, deps) => {
  app.post(
    '/v1/sessions/:id/share-links',
    { config: { auth: { scopes: ['sessions:host'] }, idempotency: 'accepted' } },
    async (request, reply) => {
      const caller = callerOf(request);
      const body = await deps.service.create(
        param(request, 'id'),
        caller.userId,
        request.body,
        auditOf(request),
      );
      reply.header('cache-control', NO_STORE).code(201);
      return body;
    },
  );

  app.delete(
    '/v1/sessions/:id/share-links/:token',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      await deps.service.revoke(
        param(request, 'id'),
        param(request, 'token'),
        caller.userId,
        auditOf(request),
      );
      return reply.code(204).send();
    },
  );

  /**
   * B104 (CT-API-SESSIONS, CT-CRYPTO 4a): the live members' public device keys for a share-link
   * guest, so a view-only guest can check who signed a frame. The link token is the credential.
   * No user ids, no e-mail, nothing of the workspace; `join`'s refusals and a rate limit of its own.
   */
  app.get('/v1/share-links/:token/members', { config: { auth: false } }, async (request, reply) => {
    const clock = deps.clock ?? Date.now;
    const token = param(request, 'token');
    const access = await deps.service.membersAccess(token, request.ip);
    const page = parsePageQuery(request.query ?? {}, GUEST_LIST_SPEC);
    const f = createHash('sha256')
      .update(`guest-members:${access.sessionId}`)
      .digest('base64url')
      .slice(0, 22);
    let after = 0;
    if (page.cursor !== undefined) {
      const decoded = decodeCursor(page.cursor, deps.cursorKeys, clock(), {
        filterHash: f,
        sort: GUEST_SORT,
      });
      const last = decoded.k[0];
      if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) {
        throw new AppError('cursor_invalid', { detail: 'The cursor is not valid.' });
      }
      after = last;
    }
    const rows = await deps.members.members(access.sessionId, after, page.limit);
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    const next =
      rows.length > page.limit && last !== undefined
        ? encodeCursor({ k: [last.joinOrder], f, s: GUEST_SORT }, deps.cursorKeys, clock())
        : null;
    reply.header('cache-control', NO_STORE);
    const body: Api.SessionMemberPage = {
      data: shown.map((m) => guestView(memberBody(m, access.inWorkspace))),
      next_cursor: next,
      has_more: next !== null,
    };
    return body;
  });

  app.post('/v1/share-links/:token/join', { config: { auth: false } }, async (request, reply) => {
    const body = await deps.service.join(param(request, 'token'), request.body, request.ip);
    reply.header('cache-control', NO_STORE);
    return body;
  });
};

/** Adds the share-link routes to `app` (after the auth, idempotency, RBAC and audit plugins). */
export function registerShareLinkRoutes(app: FastifyInstance, deps: ShareLinkRouteDeps): void {
  void app.register(plugin, deps);
}
