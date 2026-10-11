/**
 * Test helpers for presence history on Postgres 16 (B010's stack): a live session in a workspace
 * with members on devices, the writer and the lookups over it with a settable clock.
 */
import { createFactories } from '@centcom/testkit';
import {
  createPostgresHistoryWriter,
  createPostgresPresenceHistory,
  type PresenceHistoryDb,
} from '../../src/presence-history/queries.js';
import type { TestStack } from '../slots/helpers.js';

export async function pgEnv(stack: TestStack) {
  const f = createFactories(stack.db);
  const db = stack.db as unknown as PresenceHistoryDb;
  const clock = { now: Date.parse('2026-10-11T12:00:30.000Z') };
  const workspace = await f.workspaces.create();
  const session = async () => f.sessions.create({ workspace: workspace.id, state: 'live' });
  const member = async (sid: string) => {
    const user = await f.users.create();
    await f.memberships.create({ workspace: workspace.id, user: user.id, role: 'member' });
    const device = await f.devices.create({ user: user.id });
    const m = await f.sessionMembers.create({
      session: sid,
      user: user.id,
      device: device.id,
      role: 'editor',
    });
    return { id: m.id, device: device.id };
  };
  return {
    db,
    clock,
    session,
    member,
    writer: createPostgresHistoryWriter(db),
    history: createPostgresPresenceHistory(db, () => clock.now),
  };
}
