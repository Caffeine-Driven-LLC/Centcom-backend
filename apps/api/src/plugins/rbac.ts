/**
 * RBAC for routes (B021): the plugin puts the authorizer and the way to find a request's actor on
 * the instance; routes guard themselves with preHandlers instead of comparing roles:
 *
 *   app.patch('/v1/workspaces/:id', {
 *     preHandler: [requireScope('workspaces:write'),
 *                  requirePermission('workspace.update', (req) => ({ workspaceId: req.params.id }))],
 *   }, handler);
 *
 * No actor: 401 `unauthorized`. A missing scope or a denied action: 403 `forbidden` (the
 * authorizer audits privileged denials); a route may answer 404 instead, so a hidden resource is
 * not confirmed to exist. The actor comes from `actor(request)`; with the B017 auth plugin that
 * is the request's principal.
 *
 * Owns: wiring RBAC into Fastify. Must not: decide anything itself (the engine in @centcom/core
 * does), or accept a role from the request.
 */
import {
  AppError,
  hasScope,
  notFound,
  type Action,
  type Actor,
  type Authorizer,
  type Resource,
  type Scope,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

/** What the plugin puts on the instance. */
export interface RbacContext {
  authorizer: Authorizer;
  /** The actor of a request, or null when it is not authenticated. */
  actor: (request: FastifyRequest) => Actor | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    rbac: RbacContext;
  }
}

/** Options for `rbacPlugin`. */
export type RbacPluginOptions = RbacContext;

const unauthenticated = (): AppError =>
  new AppError('unauthorized', { detail: 'Authentication is required.' });

const plugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  app.decorate('rbac', { authorizer: opts.authorizer, actor: opts.actor });
};

/** Registers RBAC on the whole instance; register it before any route that guards itself. */
export const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-rbac',
});

/**
 * A preHandler allowing the request only when its actor may do `action` to the resource
 * `resolveResource` names (ids from the route, never from the body's claims). `hideAs404` answers
 * a denial with 404 `not_found`, for resources whose existence is not the caller's business.
 */
export function requirePermission(
  action: Action,
  resolveResource: (request: FastifyRequest) => Resource | Promise<Resource>,
  opts: { hideAs404?: boolean } = {},
): preHandlerAsyncHookHandler {
  return async function rbacPermission(request) {
    const { authorizer, actor: actorOf } = request.server.rbac;
    const actor = actorOf(request);
    if (actor === null) throw unauthenticated();
    const resource = await resolveResource(request);
    try {
      await authorizer.authorize(actor, action, resource);
    } catch (err) {
      if (opts.hideAs404 === true && err instanceof AppError && err.code === 'forbidden')
        throw notFound();
      throw err;
    }
  };
}

/** A preHandler allowing the request only when its actor holds `scope` (CT-AUTH). */
export function requireScope(scope: Scope): preHandlerAsyncHookHandler {
  return async function rbacScope(request) {
    const actor = request.server.rbac.actor(request);
    if (actor === null) throw unauthenticated();
    if (!hasScope(actor, scope)) {
      throw new AppError('forbidden', {
        detail: 'The credential does not hold a scope this request needs.',
      });
    }
  };
}
