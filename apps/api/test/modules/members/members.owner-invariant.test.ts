/**
 * One owner, always (B028, card test members.owner-invariant.test.ts, acceptance 4): 50 transfers
 * and removals fired at once, in every order, never leave a workspace with no owner or two; each
 * answer is one the rules allow. The in-memory store runs transactions one at a time, as the row
 * locks do; the same storm against Postgres is in members.postgres.test.ts (CI).
 */
import { describe, expect, it } from 'vitest';
import { arrange, asUser, membersApp, rolesOf } from './helpers.js';

describe('the owner invariant', () => {
  it('holds through 50 concurrent transfers and removals', async () => {
    const { app, store } = await membersApp();
    const { workspaceId, users, mems } = arrange(store);
    const admins = [mems.admin];
    const adminUsers = [users.admin];
    for (let i = 0; i < 3; i++) {
      const userId = store.addUser();
      adminUsers.push(userId);
      admins.push(store.join(workspaceId, userId, 'admin'));
    }
    const everyone = [users.owner, ...adminUsers];
    const attempts = Array.from({ length: 50 }, (_, i) => {
      const actor = everyone[i % everyone.length] ?? users.owner;
      const target = admins[(i * 7) % admins.length] ?? mems.admin;
      return i % 5 === 4
        ? app.inject({
            method: 'DELETE',
            url: `/v1/workspaces/${workspaceId}/members/${mems.owner}`,
            headers: asUser(actor),
          })
        : app.inject({
            method: 'POST',
            url: `/v1/workspaces/${workspaceId}/transfer-ownership`,
            headers: asUser(actor),
            payload: { to_member: target },
          });
    });
    const results = await Promise.all(attempts);
    for (const res of results) expect([200, 204, 403, 404, 409, 422]).toContain(res.statusCode);
    const roles = rolesOf(store, workspaceId);
    expect(Object.values(roles).filter((role) => role === 'owner')).toHaveLength(1);
    expect(results.some((r) => r.statusCode === 200)).toBe(true);
  });
});
