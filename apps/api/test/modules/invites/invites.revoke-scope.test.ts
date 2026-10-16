/**
 * Revoking a workspace invite needs `workspaces:write` even where session invites are on (B105):
 * `sessions:host` (which CLI tokens hold, and `workspaces:write` they do not) only stands in for
 * the scope of a session invite, never for a workspace invite's.
 */
import { describe, expect, it } from 'vitest';
import { arrange, asUser, createInvite, invitesApp, type InvitesApp } from './helpers.js';

const revoke = (t: InvitesApp, inviteId: string, userId: string, scopes?: string) =>
  t.app.inject({
    method: 'DELETE',
    url: `/v1/invites/${inviteId}`,
    headers: asUser(userId, scopes),
  });

describe('DELETE /v1/invites/{id} with session invites on', () => {
  it('refuses a workspace invite to a token with sessions:host but not workspaces:write', async () => {
    const t = await invitesApp({ withSessionInvites: true });
    const { workspaceId, users } = arrange(t.store);
    const invite = await createInvite(t, workspaceId, users.admin);
    const res = await revoke(t, invite.id, users.owner, 'profile sessions:host sessions:read');
    expect(res.statusCode).toBe(403);
    // Still pending: the preview answers, it does not say revoked.
    expect((await t.app.inject({ url: `/v1/invites/${invite.token}` })).statusCode).toBe(200);
  });

  it('still revokes it for a token with workspaces:write', async () => {
    const t = await invitesApp({ withSessionInvites: true });
    const { workspaceId, users } = arrange(t.store);
    const invite = await createInvite(t, workspaceId, users.admin);
    expect((await revoke(t, invite.id, users.owner)).statusCode).toBe(204);
  });
});
