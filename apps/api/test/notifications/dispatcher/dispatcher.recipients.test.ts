/**
 * Recipients (B063, card test dispatcher.recipients.test.ts, acceptance 6 and the membership
 * guardrail): `{workspace, roles}` reaches only active members with those roles, never one who
 * left; `{session, members}` only members still in the session; `{users}` only active users, and
 * only those still in the session the params name. In memory and on Postgres 16 (CI).
 */
import { newId } from '@centcom/contracts';
import { createNotificationStore, type NotificationDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  resolveRecipients,
  type RecipientDirectory,
} from '../../../src/modules/notifications/dispatcher/index.js';
import { MemoryNotificationStore, testDispatcher } from './helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgJoinSession,
  pgSession,
  pgUser,
  pgWorkspace,
} from './postgres.js';

describe('recipients in memory (acceptance 6)', () => {
  it('resolves {workspace, roles} to the active members of those roles only', async () => {
    const store = new MemoryNotificationStore();
    const workspace = store.addWorkspace();
    const [owner, admin, member, gone] = [
      store.addUser(),
      store.addUser(),
      store.addUser(),
      store.addUser('deleted'),
    ];
    store.join(workspace, owner, 'owner');
    store.join(workspace, admin, 'admin');
    store.join(workspace, member, 'member');
    store.join(workspace, gone, 'admin');
    const leaver = store.addUser();
    store.join(workspace, leaver, 'admin');
    // Leaving deletes the membership (B028).
    store.memberships = store.memberships.filter((m) => m.userId !== leaver);
    const recipients = await resolveRecipients(
      {
        category: 'usage_warning',
        recipients: { workspace, roles: ['owner', 'admin'] },
        params: {},
      },
      store,
    );
    expect(recipients).toEqual([owner, admin].sort());
  });

  it('resolves {session, members} to members still in the session, once per user', async () => {
    const store = new MemoryNotificationStore();
    const session = newId('ses');
    const [a, b, c] = [store.addUser(), store.addUser(), store.addUser()];
    const ma = store.joinSession(session, a);
    const ma2 = store.joinSession(session, a);
    const mb = store.joinSession(session, b, new Date());
    const mc = store.joinSession(newId('ses'), c);
    const recipients = await resolveRecipients(
      { category: 'mention', recipients: { session, members: [ma, ma2, mb, mc] }, params: {} },
      store,
    );
    expect(recipients).toEqual([a]);
  });

  it('keeps {users} to active users, and to those in the session the params name', async () => {
    const t = testDispatcher();
    const session = newId('ses');
    const [inSession, outside, left, deleted] = [
      t.store.addUser(),
      t.store.addUser(),
      t.store.addUser(),
      t.store.addUser('deleted'),
    ];
    t.store.joinSession(session, inSession);
    t.store.joinSession(session, left, new Date());
    t.store.joinSession(session, deleted);
    await t.dispatcher.publish({
      category: 'mention',
      recipients: { users: [inSession, outside, left, deleted, inSession] },
      params: { session },
    });
    await t.dispatcher.publish({
      category: 'trial_ending',
      recipients: { users: [outside, deleted] },
      params: { days: 2 },
    });
    await t.drain();
    expect(t.store.rows.map((r) => [r.category, r.userId])).toEqual([
      ['mention', inSession],
      ['trial_ending', outside],
    ]);
  });
});

describe.runIf(ADMIN_URL !== undefined)('recipients on Postgres 16', () => {
  it('reads memberships, session members and user status from the database', async () => {
    const t = await migratedDatabase(5);
    try {
      const store: RecipientDirectory = createNotificationStore(
        t.db as unknown as Kysely<NotificationDb>,
      );
      const owner = await pgUser(t.db);
      const admin = await pgUser(t.db);
      const member = await pgUser(t.db);
      const deleted = await pgUser(t.db, 'deleted');
      const workspace = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, workspace, owner, 'owner');
      await pgJoin(t.db, workspace, admin, 'admin');
      await pgJoin(t.db, workspace, member, 'member');
      await pgJoin(t.db, workspace, deleted, 'admin');
      expect(
        await resolveRecipients(
          {
            category: 'usage_warning',
            recipients: { workspace, roles: ['owner', 'admin'] },
            params: {},
          },
          store,
        ),
      ).toEqual([owner, admin].sort());
      const deletedWorkspace = await pgWorkspace(t.db, owner, true);
      await pgJoin(t.db, deletedWorkspace, owner, 'owner');
      expect(
        await resolveRecipients(
          {
            category: 'usage_warning',
            recipients: { workspace: deletedWorkspace, roles: ['owner'] },
            params: {},
          },
          store,
        ),
      ).toEqual([]);

      const session = await pgSession(t.db, workspace, owner);
      const mOwner = await pgJoinSession(t.db, session, owner);
      const mLeft = await pgJoinSession(t.db, session, admin, true);
      const mDeleted = await pgJoinSession(t.db, session, deleted);
      expect(
        await resolveRecipients(
          {
            category: 'mention',
            recipients: { session, members: [mOwner, mLeft, mDeleted] },
            params: {},
          },
          store,
        ),
      ).toEqual([owner]);
      expect(
        await resolveRecipients(
          {
            category: 'mention',
            recipients: { users: [owner, admin, member, deleted] },
            params: { session },
          },
          store,
        ),
      ).toEqual([owner]);
      expect(
        await resolveRecipients(
          {
            category: 'trial_ending',
            recipients: { users: [member, deleted] },
            params: { days: 1 },
          },
          store,
        ),
      ).toEqual([member]);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
