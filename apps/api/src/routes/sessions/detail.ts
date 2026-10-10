/**
 * `GET /v1/sessions/{id}`, `PATCH /v1/sessions/{id}` and `POST /v1/sessions/{id}/end` (B054,
 * CT-API-SESSIONS). A session the caller may not see is 404 for all three (`access.ts`).
 *
 * - **GET** (`sessions:read`): the `Session` with its ETag.
 * - **PATCH** (`sessions:host`, the host): `{name?, policy?}` (at least one; a name of 1-80
 *   characters, else 422 at `/name`). Anyone but the host gets 403 `host_required` (audited
 *   `permission.denied`, as an end refused is). `If-Match` is
 *   optional (CT-API-SESSIONS does not require it); when sent, it must name the current ETag, else
 *   412 `precondition_failed` (CT-PAGE, contracts/00-foundations.md: "PATCH accepts If-Match;
 *   mismatch is 412"). The host check, the compare, the writes and the `control.policy` audit
 *   event (the names of the fields sent) are one transaction with the session's row locked
 *   (`store.patchSession`), so two PATCHes with the same ETag cannot both pass and a PATCH never
 *   half applies. An ended session is 410 `session_ended`. 200 with the new ETag.
 * - **end** (`sessions:host`): B053 `end` (the host, or a workspace owner or admin; anyone else
 *   403 `host_required`). An ended session is returned as it is. Audited `session.end` when this
 *   call ended it.
 *
 * A transition B053's state machine refuses is 409 `conflict`, with nothing changed.
 *
 * Owns: the HTTP side of these three. Must not: write a session's lifecycle state (B053 does).
 */
import { checkName } from '@centcom/contracts';
import { AppError, validationFailed } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  toSession,
  type Session,
  type SessionPolicyDefaults,
} from '../../modules/sessions/index.js';
import {
  callerOf,
  maySee,
  notVisible,
  parseIfMatch,
  sessionBody,
  sessionEtag,
  SESSION_ROUTE_DETAILS,
  sessionIdOf,
  sessionOver,
  type Caller,
} from './access.js';
import type { SessionRouteDeps } from './index.js';
import { parsePolicy, stateConflict } from './list-create.js';
import type { Standing } from './store.js';

/** Session bodies: private, revalidated with the ETag. */
const CACHE = 'private, no-cache';

/** The body of a PATCH: at least one of `name`, `policy`. */
function parsePatch(body: unknown): { name?: string; policy?: Partial<SessionPolicyDefaults> } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const b = body as Record<string, unknown>;
  if (b['name'] === undefined && b['policy'] === undefined) {
    throw validationFailed([
      { pointer: '', code: 'required', detail: 'send at least one of name and policy' },
    ]);
  }
  let name: string | undefined;
  if (b['name'] !== undefined) {
    const checked = checkName('sessionName', b['name']);
    if (!checked.ok) {
      throw validationFailed(
        checked.errors.map((e) => ({ pointer: '/name', code: e.code, detail: e.detail })),
      );
    }
    name = checked.value;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(b['policy'] === undefined ? {} : { policy: parsePolicy(b['policy'], '/policy') }),
  };
}

/** The session and the caller's standing; 404 when they may not see it. */
async function visible(
  request: FastifyRequest,
  deps: SessionRouteDeps,
  caller: Caller,
  sid: string,
): Promise<Standing> {
  const standing = await deps.store.standing(sid, caller.userId);
  if (standing === null || !(await maySee(request, caller, standing))) throw notVisible();
  return standing;
}

/**
 * 403 `host_required`, with the refusal audited (CT-RBAC rule 6: every denied privileged action):
 * `permission.denied`, `attempted` the CT-API-AUDIT action the call would have been.
 */
function hostRequired(
  request: FastifyRequest,
  standing: Standing,
  attempted: 'control.policy' | 'control.end',
): AppError {
  request.audit.detached({
    action: 'permission.denied',
    workspaceId: standing.session.workspaceId,
    target: { type: 'session', id: standing.session.id },
    outcome: 'denied',
    meta: { attempted, reason: 'role', session_id: standing.session.id },
  });
  return new AppError('host_required', { detail: 'Only the host can do that.' });
}

export const detailRoutes: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  const clock = deps.clock ?? Date.now;
  const required = async (sid: string): Promise<Session> => {
    const session = await deps.service.get(sid);
    if (session === null) throw notVisible();
    return session;
  };

  app.get(
    '/v1/sessions/:id',
    { config: { auth: { scopes: ['sessions:read'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      await visible(request, deps, caller, sid);
      const session = await required(sid);
      reply.header('etag', sessionEtag(session)).header('cache-control', CACHE);
      return sessionBody(session);
    },
  );

  app.patch(
    '/v1/sessions/:id',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const standing = await visible(request, deps, caller, sid);
      const isHost =
        standing.member !== null && standing.member.id === standing.session.hostMemberId;
      if (!isHost) throw hostRequired(request, standing, 'control.policy');
      const patch = parsePatch(request.body);
      const ifMatch = parseIfMatch(request.headers['if-match']);
      const result = await deps.store.patchSession(
        sid,
        caller.userId,
        patch,
        new Date(clock()),
        (current) => {
          const etag = sessionEtag(toSession(current));
          if (ifMatch !== undefined && ifMatch !== '*' && !ifMatch.includes(etag)) {
            throw new AppError('precondition_failed', { detail: SESSION_ROUTE_DETAILS.stale });
          }
        },
        (trx) =>
          request
            .audit(trx, {
              action: 'control.policy',
              workspaceId: standing.session.workspaceId,
              target: { type: 'session', id: sid },
              meta: { session_id: sid, fields: Object.keys(patch).sort().join(',') },
            })
            .then(() => undefined),
      );
      if (result.kind === 'gone') throw notVisible();
      if (result.kind === 'not_host') throw hostRequired(request, standing, 'control.policy');
      if (result.kind === 'over') throw sessionOver();
      const session = toSession(result.session);
      reply.header('etag', sessionEtag(session)).header('cache-control', CACHE);
      return sessionBody(session);
    },
  );

  app.post(
    '/v1/sessions/:id/end',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const standing = await visible(request, deps, caller, sid);
      const before = standing.session.state;
      const session = await deps.service
        .end(sid, { userId: caller.userId, reason: 'done' })
        .catch((err: unknown) => {
          if (err instanceof AppError && err.code === 'host_required') {
            throw hostRequired(request, standing, 'control.end');
          }
          return stateConflict(err);
        });
      if (before !== 'ended' && before !== 'expired' && session.state === 'ended') {
        request.audit.detached({
          action: 'session.end',
          workspaceId: session.workspace === '' ? null : session.workspace,
          target: { type: 'session', id: sid },
          meta: { reason: 'done' },
        });
      }
      reply.header('etag', sessionEtag(session)).header('cache-control', CACHE);
      return sessionBody(session);
    },
  );
};
