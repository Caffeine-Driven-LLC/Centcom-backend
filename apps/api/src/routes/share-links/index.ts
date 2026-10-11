/**
 * Share-link routes (B068, CT-API-SESSIONS):
 *
 * | Route                                          | Scope           | Who       | Answer                    |
 * | ---------------------------------------------- | --------------- | --------- | ------------------------- |
 * | `POST /v1/sessions/{id}/share-links`           | `sessions:host` | the host  | 201 `ShareLink` + max_uses |
 * | `DELETE /v1/sessions/{id}/share-links/{token}` | `sessions:host` | the host  | 204                       |
 * | `POST /v1/share-links/{token}/join`            | none (public)   | anyone    | 200 `JoinToken` (viewer)  |
 *
 * `Idempotency-Key` is accepted on create (a replay answers the same link). Create and join
 * answers are `Cache-Control: no-store`: they carry a token or a ticket. The rules are
 * `ShareLinkService`'s; `standingOf(store)` reads the caller's standing from B054's route store,
 * with B054's role cap. An API key is refused as on every session route.
 *
 * Owns: the HTTP surface. Must not: log a token or a ticket (paths with a token are not logged by
 * the handlers; the request log carries the route template).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  HostStanding,
  RouteAudit,
  ShareLinkService,
} from '../../modules/share-links/service.js';
import { callerOf, liveRole } from '../sessions/access.js';
import type { SessionRouteStore } from '../sessions/store.js';

/** What the routes need. */
export interface ShareLinkRouteDeps {
  service: Pick<ShareLinkService, 'create' | 'revoke' | 'join'>;
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
