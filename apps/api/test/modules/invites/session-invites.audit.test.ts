/**
 * The audit events of session invites (B108): their shape for each action, the actor of a revoke,
 * and that nothing of the invite beyond its id, workspace and role is in them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sessionInviteAuditEvent } from '../../../src/modules/invites/session-invite-audit.js';

const invite = {
  id: 'inv_01M4SYJHKWNG75SCKPQ0WAVF10',
  workspaceId: 'wsp_01M4SYJHKWNG75SCKPQ0WAVF10',
  role: 'editor' as const,
};

describe('session invite audit events', () => {
  it('create: the creator, the role and kind session', () => {
    expect(sessionInviteAuditEvent('invite.create', invite, 'usr_a')).toEqual({
      workspaceId: invite.workspaceId,
      actor: { type: 'user', id: 'usr_a' },
      action: 'invite.create',
      target: { type: 'invite', id: invite.id },
      outcome: 'success',
      meta: { role: 'editor', kind: 'session' },
    });
  });

  it('accept: the user who accepted, with the role they got', () => {
    expect(
      sessionInviteAuditEvent('invite.accept', { ...invite, role: 'viewer' }, 'usr_b'),
    ).toMatchObject({
      actor: { id: 'usr_b' },
      action: 'invite.accept',
      meta: { user_id: 'usr_b', role: 'viewer' },
    });
  });

  it('revoke: the revoking user (not necessarily the creator) and no meta', () => {
    const event = sessionInviteAuditEvent('invite.revoke', invite, 'usr_host');
    expect(event.actor).toEqual({ type: 'user', id: 'usr_host' });
    expect(event.meta).toEqual({});
  });

  it('a session invite outside a workspace has a null workspace', () => {
    expect(
      sessionInviteAuditEvent('invite.create', { ...invite, workspaceId: null }, 'usr_a')
        .workspaceId,
    ).toBeNull();
  });

  it('never holds a token, its hash or an address, whatever the invite record carries (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8 }),
        fc.emailAddress(),
        fc.constantFrom('invite.create', 'invite.accept', 'invite.revoke' as const),
        (token, email, action) => {
          const record = { ...invite, token, tokenHash: `h${token}`, email } as typeof invite;
          const json = JSON.stringify(sessionInviteAuditEvent(action as never, record, 'usr_a'));
          expect(json).not.toContain(email);
          if (token.length >= 8 && !'invite.createacceptrevoke'.includes(token))
            expect(json).not.toContain(token);
        },
      ),
      { numRuns: 200 },
    );
  });
});
