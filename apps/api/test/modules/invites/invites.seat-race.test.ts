/**
 * Seats (B029 acceptance 5): accepting asks B030's seat gate inside the transaction that adds the
 * member, after the workspace row is locked. A refusal is a 403 of the entitlement family that
 * creates nothing and leaves the invite pending; 10 accepts racing for the last seat make exactly
 * one membership (the requests are held until all 10 wait, so a check outside the transaction
 * would let them all in). With B030's count (members and pending invites), accepting an invite
 * does not count it twice. The same race against Postgres's locks is in invites.postgres.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addUser,
  arrange,
  asInvitee,
  createInvite,
  invitesApp,
  type InvitesApp,
} from './helpers.js';

const accept = (t: InvitesApp, token: string, userId: string) =>
  t.app.inject({ method: 'POST', url: `/v1/invites/${token}/accept`, headers: asInvitee(userId) });

describe('the seat gate on accept', () => {
  it('refuses with 403 (entitlement family), creating nothing; the invite stays usable', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin, { role: 'admin' });
    const invitee = addUser(t.store);
    const audited = t.store.audit.length;
    t.seats.deny = true;
    const denied = await accept(t, created.token, invitee);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'entitlement_required' });
    t.seats.deny = false;
    t.seats.seats = 5;
    const full = await accept(t, created.token, invitee);
    expect(full.statusCode).toBe(403);
    expect(full.json()).toMatchObject({ code: 'seat_limit_reached' });
    expect(t.store.memberships.some((m) => m.userId === invitee)).toBe(false);
    expect(t.inviteStore.rows.get(created.id)).toMatchObject({
      acceptedAt: null,
      acceptedBy: null,
    });
    expect(t.store.audit).toHaveLength(audited);
    expect(t.recorded.count('invites_accepted_total')).toBe(0);
    // A seat frees up: the same invite works.
    t.seats.seats = 6;
    expect((await accept(t, created.token, invitee)).statusCode).toBe(201);
  });

  it('lets exactly one of 10 concurrent accepts take the last seat', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    const invites = [];
    for (let i = 0; i < 10; i++) invites.push(await createInvite(t, workspaceId, users.admin));
    const invitees = invites.map(() => addUser(t.store));
    t.seats.seats = 6; // five members: one seat left
    let release = (): void => undefined;
    t.inviteStore.gate = new Promise<void>((resolve) => (release = resolve));
    const racing = Promise.all(invites.map((inv, i) => accept(t, inv.token, invitees[i] ?? '')));
    await vi.waitFor(() => expect(t.inviteStore.waiting).toBe(10));
    release();
    const results = await racing;
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, ...Array<number>(9).fill(403)]);
    for (const refused of results.filter((r) => r.statusCode === 403)) {
      expect(refused.json()).toMatchObject({ code: 'seat_limit_reached' });
    }
    const joined = t.store.memberships.filter((m) => invitees.includes(m.userId));
    expect(joined).toHaveLength(1);
    expect(t.store.memberships.filter((m) => m.workspaceId === workspaceId)).toHaveLength(6);
    const accepted = [...t.inviteStore.rows.values()].filter((r) => r.acceptedAt !== null);
    expect(accepted.map((r) => r.acceptedBy)).toEqual([joined[0]?.userId]);
    expect(t.seats.calls.slice(-10).every((c) => c.inTransaction)).toBe(true);
  });

  it('with B030’s count of pending invites, does not count the accepted invite twice', async () => {
    const t = await invitesApp();
    const { workspaceId, users } = arrange(t.store);
    t.seats.countPendingInvites = true;
    t.seats.seats = 6;
    // Five members and this invite: every seat is taken or reserved.
    const created = await createInvite(t, workspaceId, users.admin);
    expect(t.seats.usage(workspaceId)).toBe(6);
    const more = await createInvite(t, workspaceId, users.admin);
    expect(more.status).toBe(403);
    expect((await accept(t, created.token, addUser(t.store))).statusCode).toBe(201);
    expect(t.seats.usage(workspaceId)).toBe(6);
  });
});
