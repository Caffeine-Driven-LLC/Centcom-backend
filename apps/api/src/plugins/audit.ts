/**
 * Audit for routes (B036): `request.audit(trx, input)` writes an audit event in the handler's
 * transaction (CT-API-AUDIT: a state-changing endpoint audits in the same transaction as its
 * change), and `request.audit.detached(input)` queues one where there is no transaction, such as
 * a refusal. Both fill in what the request knows, so a handler names only the action, target,
 * outcome (default `success`) and meta:
 *
 * - the actor: the request's user or API key, from the RBAC plugin's `actor`;
 * - the request id: the request's `req_` id (the X-Request-Id it was answered with);
 * - the workspace: `:id` of a /v1/workspaces/:id route, else the API key's workspace, else null.
 *
 * An input may still name its own actor or workspace (null for an account-level event). Closing
 * the app flushes the emitter's queue for up to AUDIT_CLOSE_FLUSH_MS.
 *
 *   await withTransaction(db, async (trx) => {
 *     await memberships.remove(trx, id);
 *     await request.audit(trx, { action: 'member.remove', target: { type: 'membership', id } });
 *   });
 *
 * Owns: filling events from requests. Must not: decide whether to audit (handlers do), or take
 * the actor or workspace from anything the client sends but the route.
 */
import { isId } from '@centcom/contracts';
import {
  getRequestContext,
  type AuditActor,
  type AuditDb,
  type AuditEmitter,
  type AuditEvent,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

/** How long closing the app waits for queued audit events to be written. */
export const AUDIT_CLOSE_FLUSH_MS = 5000;

/** An event as a handler describes it: what the request knows may be left out. */
export type AuditInput = Omit<AuditEvent, 'workspaceId' | 'actor' | 'outcome' | 'requestId'> &
  Partial<Pick<AuditEvent, 'workspaceId' | 'actor' | 'outcome'>>;

/** `request.audit`. */
export interface RequestAudit {
  /** Writes the event in `trx`, the transaction of the change it records; resolves to its `aud_` id. */
  (trx: AuditDb, input: AuditInput): Promise<string>;
  /** Queues the event for a background write, where there is no transaction. Never throws. */
  detached(input: AuditInput): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The audit emitter, for code without a request. */
    audit: AuditEmitter;
  }
  interface FastifyRequest {
    audit: RequestAudit;
  }
}

/** Options for `auditPlugin`. */
export interface AuditPluginOptions {
  emitter: AuditEmitter;
  /** The actor of a request; default `rbacAuditActor`. */
  actor?: (request: FastifyRequest) => AuditActor | null;
  /** The workspace of a request whose input names none; default `requestWorkspace`. */
  workspace?: (request: FastifyRequest) => string | null;
}

/** The request's user or API key, as the RBAC plugin finds it; null without one (or without RBAC). */
export function rbacAuditActor(request: FastifyRequest): AuditActor | null {
  if (!request.server.hasDecorator('rbac')) return null;
  const actor = request.server.rbac.actor(request);
  if (actor?.kind === 'user') return { type: 'user', id: actor.userId };
  if (actor?.kind === 'api_key') return { type: 'api_key', id: actor.keyId };
  return null;
}

/** /v1/workspaces/:id and the routes below it. */
const WORKSPACE_ROUTE = /^\/v1\/workspaces\/:id(?:\/|$)/;

/** The workspace a request acts in: `:id` of /v1/workspaces/:id routes, else the API key's, else null. */
export function requestWorkspace(request: FastifyRequest): string | null {
  const id = (request.params as Record<string, unknown> | undefined)?.['id'];
  if (WORKSPACE_ROUTE.test(request.routeOptions.url ?? '') && isId('wsp', id)) return id;
  if (request.server.hasDecorator('rbac')) {
    const actor = request.server.rbac.actor(request);
    if (actor?.kind === 'api_key' && isId('wsp', actor.workspaceId)) return actor.workspaceId;
  }
  return null;
}

const plugin: FastifyPluginAsync<AuditPluginOptions> = async (app, opts) => {
  const { emitter } = opts;
  const actorOf = opts.actor ?? rbacAuditActor;
  const workspaceOf = opts.workspace ?? requestWorkspace;

  /** The input plus what the request knows. Without an actor the emitter refuses the event. */
  const fill = (request: FastifyRequest, input: AuditInput): AuditEvent => {
    const { workspaceId, actor, outcome, ...rest } = input;
    const who = actor ?? actorOf(request);
    const requestId = isId('req', request.id) ? request.id : getRequestContext()?.requestId;
    return {
      ...rest,
      workspaceId: workspaceId === undefined ? workspaceOf(request) : workspaceId,
      ...(who === null ? {} : { actor: who }),
      outcome: outcome ?? 'success',
      ...(requestId === undefined ? {} : { requestId }),
    } as AuditEvent;
  };

  app.decorate('audit', emitter);
  app.decorateRequest('audit', null, []);
  app.addHook('onRequest', (request, _reply, done) => {
    const audit = async (trx: AuditDb, input: AuditInput): Promise<string> =>
      emitter.emit(trx, fill(request, input));
    request.audit = Object.assign(audit, {
      detached(input: AuditInput): void {
        let event: AuditEvent;
        try {
          event = fill(request, input);
        } catch {
          // A throwing `actor` or `workspace` option: the incomplete event is refused by the
          // emitter, which counts and logs it, so the loss is not silent.
          event = input as AuditEvent;
        }
        emitter.emitDetached(event);
      },
    });
    done();
  });
  app.addHook('onClose', async () => {
    await emitter.flush(AUDIT_CLOSE_FLUSH_MS);
  });
};

/** Registers `request.audit` on the whole instance, after the request-context and RBAC plugins. */
export const auditPlugin: FastifyPluginAsync<AuditPluginOptions> = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-audit',
});
