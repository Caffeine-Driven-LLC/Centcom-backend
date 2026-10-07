/**
 * RBAC denials into the audit log (B036 for B021, CT-RBAC rule 6): `rbacAuditSink(emitter)` is the
 * AuditSink `createAuthorizer` records refused privileged actions with. Each becomes a
 * `permission.denied` event with outcome `denied`, written in the background (a refusal changes
 * nothing, so there is no transaction to join).
 *
 * Owns: the mapping from RbacDeniedEvent. Must not: block or fail the denial (emitDetached never
 * throws), or record anything but ids and the RBAC action and reason.
 */
import { isId } from '@centcom/contracts';
import { getRequestContext } from '../log/context.js';
import type { AuditSink, RbacDeniedEvent } from '../rbac/can.js';
import type { AuditEmitter } from './emitter.js';
import type { AuditEvent } from './event.js';

/** The `permission.denied` event of an RBAC denial; the request id comes from the request context. */
export function deniedEvent(denied: RbacDeniedEvent): AuditEvent<'permission.denied'> {
  const { actor, resource } = denied;
  const workspaceId =
    resource.workspaceId ?? (actor.kind === 'api_key' ? actor.workspaceId : undefined);
  const requestId = getRequestContext()?.requestId;
  return {
    workspaceId: isId('wsp', workspaceId) ? workspaceId : null,
    actor: { type: actor.kind, id: actor.id },
    action: 'permission.denied',
    ...(isId('ses', resource.sessionId)
      ? { target: { type: 'session', id: resource.sessionId } }
      : {}),
    outcome: 'denied',
    ...(isId('req', requestId) ? { requestId } : {}),
    meta: {
      attempted: denied.attempted,
      reason: denied.reason,
      ...(isId('usr', resource.ownerUserId) ? { owner_user_id: resource.ownerUserId } : {}),
    },
  };
}

/** An AuditSink for `createAuthorizer` that records denials through `emitter`. */
export function rbacAuditSink(emitter: Pick<AuditEmitter, 'emitDetached'>): AuditSink {
  return {
    record(event) {
      emitter.emitDetached(deniedEvent(event));
      return Promise.resolve();
    },
  };
}
