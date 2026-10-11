/**
 * B060 deciders on Postgres 16 (B010's test stack: DATABASE_URL, or a container runtime): a
 * session member's live role with the user's workspace role (owner, admin, member), so the `owner`
 * approver finds workspace owners and admins; a member who left, or whose workspace membership is
 * gone, is no decider; a workspace guest is capped to viewer (CT-RBAC); `members` lists the
 * session's current deciders the same way (the notification's recipients).
 */
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDeciders } from '../../src/approvals/postgres.js';
import type { RelayDb } from '../../src/modules.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';

describe.runIf(STACK)('approval deciders on Postgres 16', () => {
  let stack: TestStack;
  let db: RelayDb;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as RelayDb;
    f = createFactories(stack.db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('reads live session roles with workspace roles', async () => {
    const ownerUser = await f.users.create();
    const workspace = await f.workspaces.create({ owner: ownerUser.id });
    const session = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    const join = async (
      user: { id: string },
      role: 'host' | 'editor' | 'viewer',
      workspaceRole: 'admin' | 'member' | 'guest' | null,
    ) => {
      if (workspaceRole !== null) {
        await f.memberships.create({ workspace: workspace.id, user: user.id, role: workspaceRole });
      }
      const device = await f.devices.create({ user: user.id });
      return f.sessionMembers.create({
        session: session.id,
        user: user.id,
        device: device.id,
        role,
      });
    };
    const host = await join(ownerUser, 'host', null);
    const adminUser = await f.users.create();
    const admin = await join(adminUser, 'editor', 'admin');
    const memberUser = await f.users.create();
    const editor = await join(memberUser, 'editor', 'member');
    const guest = await join(await f.users.create(), 'editor', 'guest');

    const deciders = createPostgresDeciders(db);
    expect(await deciders.get(session.id, host.id)).toEqual({
      role: 'host',
      userId: ownerUser.id,
      workspaceId: workspace.id,
      workspaceRole: 'owner',
    });
    expect(await deciders.get(session.id, admin.id)).toMatchObject({
      role: 'editor',
      workspaceRole: 'admin',
    });
    expect(await deciders.get(session.id, editor.id)).toMatchObject({
      role: 'editor',
      workspaceRole: 'member',
    });
    expect(await deciders.get(session.id, guest.id)).toMatchObject({
      role: 'viewer',
      workspaceRole: 'guest',
    });

    // The session's current deciders, for the notification's recipients.
    const listed = await deciders.members(session.id);
    expect(listed.map((m) => [m.memberId, m.role, m.workspaceRole]).sort()).toEqual(
      [
        [host.id, 'host', 'owner'],
        [admin.id, 'editor', 'admin'],
        [editor.id, 'editor', 'member'],
        [guest.id, 'viewer', 'guest'],
      ].sort(),
    );

    // Left the session: no decider.
    await db
      .updateTable('session_members')
      .set({ left_at: new Date() })
      .where('id', '=', editor.id)
      .execute();
    expect(await deciders.get(session.id, editor.id)).toBeNull();
    expect((await deciders.members(session.id)).map((m) => m.memberId)).not.toContain(editor.id);
    // Left the workspace: no decider.
    await db
      .deleteFrom('memberships')
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', adminUser.id)
      .execute();
    expect(await deciders.get(session.id, admin.id)).toBeNull();
    // Another session's member id: no decider here.
    const elsewhere = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    expect(await deciders.get(elsewhere.id, host.id)).toBeNull();
  });
});
