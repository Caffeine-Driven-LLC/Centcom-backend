/**
 * Access to workspace routes (B027; B028's member routes use it too): who calls, and whether they
 * may act on workspace `:id`. Authorisation is B021's RBAC only:
 *
 * - a caller who is not a member, an API key of another workspace, or anyone asking about a
 *   deleted workspace gets 404 `not_found` whatever they asked, so a workspace's existence is
 *   never confirmed;
 * - a member whose role falls short gets 403 from the authorizer, which audits privileged
 *   denials (CT-RBAC rule 6).
 *
 * Owns: the 404-or-403 rule. Must not: compare roles itself.
 */
import { isId } from '@centcom/contracts';
import { AppError, notFound, type Action, type Actor, type Resource } from '@centcom/core';
import type { FastifyRequest } from 'fastify';
import { WORKSPACE_DETAILS, type Reader, type RequestCtx } from './service.js';

/** The detail of a 401 on these routes. */
export const UNAUTHENTICATED_DETAIL = 'Authentication is required.';

/** Denials answered with 404: the workspace's existence is not the caller's business. */
const HIDDEN_REASONS: ReadonlySet<string> = new Set([
  'not_a_member',
  'other_workspace',
  'unknown_actor',
]);

/** The request's actor, or a 401. */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.server.rbac.actor(request);
  if (actor === null) throw new AppError('unauthorized', { detail: UNAUTHENTICATED_DETAIL });
  return actor;
}

/** How the workspace service sees an actor. */
export const readerOf = (actor: Actor): Reader =>
  actor.kind === 'user'
    ? { kind: 'user', userId: actor.userId }
    : { kind: 'api_key', workspaceId: actor.workspaceId };

/**
 * Lets the request at workspace `workspaceId` (default the route's `:id`) for `action` on
 * `resource` (ids from the route and server state only): 404 when the caller may not know the
 * workspace exists, 403 (audited) when their role or the action's conditions fall short.
 * `limited` is a guest's read.
 */
export async function workspaceAccess(
  request: FastifyRequest,
  action: Action,
  resource: Omit<Resource, 'workspaceId'> = {},
  workspaceId: unknown = (request.params as Record<string, unknown>)['id'],
): Promise<{ actor: Actor; workspaceId: string; limited: boolean }> {
  const actor = actorOf(request);
  if (!isId('wsp', workspaceId)) throw notFound(WORKSPACE_DETAILS.notFound);
  const full: Resource = { ...resource, workspaceId };
  const { authorizer } = request.server.rbac;
  const decision = await authorizer.decide(actor, action, full);
  if (decision.allow) return { actor, workspaceId, limited: decision.limited === true };
  if (HIDDEN_REASONS.has(decision.reason)) throw notFound(WORKSPACE_DETAILS.notFound);
  // Records the denial (privileged actions) and throws 403; resolves only if the role changed since.
  await authorizer.authorize(actor, action, full);
  return { actor, workspaceId, limited: false };
}

/** What a request lends a service: `request.audit`, to write audit events in a transaction. */
export const ctxOf = (request: FastifyRequest): RequestCtx => ({
  audit: (trx, input) => request.audit(trx, input),
});
