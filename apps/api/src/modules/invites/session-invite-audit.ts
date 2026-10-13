/**
 * The audit events of session invites (B108): `invite.create`, `invite.accept` and `invite.revoke`
 * (CT-API-AUDIT's actions, kind `session`), built from the invite's id, workspace and role and the
 * acting user. Nothing else of the invite goes in: never the token, its hash or the address.
 *
 * Owns: the shape of the events. Must not: write them (the service hands them to the emitter).
 */
import type { AuditEvent } from '@centcom/core';
import type { SessionInviteRecord } from '@centcom/db';

/** The actions a session invite writes. */
export type SessionInviteAuditAction = 'invite.create' | 'invite.accept' | 'invite.revoke';

/** The one audit event of `action` by `actorUserId` on `invite`. */
export function sessionInviteAuditEvent(
  action: SessionInviteAuditAction,
  invite: Pick<SessionInviteRecord, 'id' | 'workspaceId' | 'role'>,
  actorUserId: string,
): AuditEvent {
  const meta: Record<string, string> =
    action === 'invite.create'
      ? { role: invite.role, kind: 'session' }
      : action === 'invite.accept'
        ? { user_id: actorUserId, role: invite.role }
        : {};
  return {
    workspaceId: invite.workspaceId,
    actor: { type: 'user', id: actorUserId },
    action,
    target: { type: 'invite', id: invite.id },
    outcome: 'success',
    meta,
  };
}
