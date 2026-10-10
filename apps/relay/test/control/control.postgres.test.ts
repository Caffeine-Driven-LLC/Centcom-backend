/**
 * The control lane's Postgres side (B051) on Postgres 16 (B010's test stack: DATABASE_URL, or a
 * container runtime), with migration 20260102003900_session_control.sql applied:
 *
 * - `session_policy`: the default without a row, a round trip with arrays and the frame's seq,
 *   an update;
 * - `session_mute`: put, list (with `until`), remove;
 * - `session_members`: a kick's removal and its undo (never the host), a role change (never the
 *   host's), the host transfer (atomic: both swapped or neither), the current members;
 * - `sessions`: end (once) and its undo;
 * - the workspace purge's order (members, then sessions) takes the policy and mutes with it.
 */
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresMuteStore } from '../../src/control/mute-registry.js';
import {
  createPostgresPolicyStore,
  DEFAULT_POLICY,
  type ControlDb,
} from '../../src/control/policy-store.js';
import {
  createPostgresMembershipPort,
  createPostgresSessionState,
} from '../../src/control/postgres.js';
import type { RelayDb } from '../../src/modules.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';

describe.runIf(STACK)('control on Postgres 16', () => {
  let stack: TestStack;
  let db: ControlDb;
  let relayDb: RelayDb;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as ControlDb;
    relayDb = stack.db as unknown as RelayDb;
    f = createFactories(stack.db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  /** A live session in a workspace, with a host and two editors. */
  async function seed() {
    const workspace = await f.workspaces.create();
    const session = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    const member = async (role: 'host' | 'editor' | 'viewer') => {
      const user = await f.users.create();
      await f.memberships.create({ workspace: workspace.id, user: user.id, role: 'member' });
      const device = await f.devices.create({ user: user.id });
      return f.sessionMembers.create({
        session: session.id,
        user: user.id,
        device: device.id,
        role,
      });
    };
    return {
      workspace,
      session,
      host: await member('host'),
      a: await member('editor'),
      b: await member('editor'),
    };
  }

  it('stores, reads and updates a session policy', async () => {
    const { session, a } = await seed();
    const store = createPostgresPolicyStore(db);
    expect(await store.read(session.id)).toEqual({ policy: DEFAULT_POLICY, updatedSeq: null });
    const policy = {
      ...DEFAULT_POLICY,
      auto_approve: 'trusted' as const,
      queue_limit: 7,
      trusted: [a.id],
      approvers: [a.id],
      queue_paused: true,
    };
    await store.set(session.id, policy, null);
    expect(await store.read(session.id)).toEqual({ policy, updatedSeq: null });
    await store.set(session.id, policy, 42);
    expect(await store.read(session.id)).toEqual({ policy, updatedSeq: 42 });
    await store.set(session.id, { ...policy, trusted: [] }, 43);
    expect((await store.get(session.id)).trusted).toEqual([]);
  });

  it('refuses a negative queue_limit (the table’s check)', async () => {
    const { session } = await seed();
    const store = createPostgresPolicyStore(db);
    await expect(
      store.set(session.id, { ...DEFAULT_POLICY, queue_limit: -1 }, 1),
    ).rejects.toThrow();
  });

  it('puts, lists and removes mutes', async () => {
    const { session, a, b } = await seed();
    const store = createPostgresMuteStore(db);
    const until = Date.parse('2030-01-01T00:00:00.000Z');
    await store.put(session.id, a.id, null);
    await store.put(session.id, b.id, until);
    expect((await store.list(session.id)).sort((x, y) => x.member.localeCompare(y.member))).toEqual(
      [
        { member: a.id, until: null },
        { member: b.id, until },
      ].sort((x, y) => x.member.localeCompare(y.member)),
    );
    await store.put(session.id, a.id, until);
    await store.remove(session.id, b.id);
    expect(await store.list(session.id)).toEqual([{ member: a.id, until }]);
  });

  it('removes a member (never the host) and undoes it', async () => {
    const { session, host, a } = await seed();
    const port = createPostgresMembershipPort(relayDb);
    expect(await port.remove(session.id, host.id, new Date())).toBe(false);
    expect(await port.remove(session.id, a.id, new Date())).toBe(true);
    expect(await port.get(session.id, a.id)).toBeNull();
    expect(await port.remove(session.id, a.id, new Date())).toBe(false);
    expect(await port.members(session.id)).not.toContain(a.id);
    await port.restore(session.id, a.id);
    expect(await port.get(session.id, a.id)).toMatchObject({ role: 'editor' });
  });

  it('changes a role, never the host’s', async () => {
    const { session, host, a } = await seed();
    const port = createPostgresMembershipPort(relayDb);
    expect(await port.setRole(session.id, a.id, 'viewer')).toBe(true);
    expect(await port.get(session.id, a.id)).toMatchObject({ role: 'viewer' });
    expect(await port.setRole(session.id, host.id, 'viewer')).toBe(false);
    expect(await port.get(session.id, host.id)).toMatchObject({ role: 'host' });
  });

  it('transfers the host atomically: both swapped, or neither', async () => {
    const { session, host, a, b } = await seed();
    const port = createPostgresMembershipPort(relayDb);
    await port.setRole(session.id, b.id, 'viewer');
    // To a viewer: neither changes.
    expect(await port.transferHost(session.id, host.id, b.id)).toBe(false);
    expect(await port.get(session.id, host.id)).toMatchObject({ role: 'host' });
    expect(await port.transferHost(session.id, host.id, a.id)).toBe(true);
    expect(await port.get(session.id, host.id)).toMatchObject({ role: 'editor' });
    expect(await port.get(session.id, a.id)).toMatchObject({ role: 'host' });
    // The old host can no longer hand it on.
    expect(await port.transferHost(session.id, host.id, a.id)).toBe(false);
    expect(await port.members(session.id)).toHaveLength(3);
  });

  it('ends a session once and undoes it', async () => {
    const { session } = await seed();
    const states = createPostgresSessionState(relayDb);
    expect(await states.end(session.id, new Date())).toBe('live');
    expect(await states.end(session.id, new Date())).toBeNull();
    const row = await relayDb
      .selectFrom('sessions')
      .select(['state', 'ended_at'])
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('ended');
    expect(row.ended_at).not.toBeNull();
    await states.restore(session.id, 'live');
    expect(await states.end(session.id, new Date())).toBe('live');
  });

  it('goes with the session in the workspace purge’s order (members, then the session)', async () => {
    const { session, a } = await seed();
    await createPostgresPolicyStore(db).set(session.id, DEFAULT_POLICY, 1);
    await createPostgresMuteStore(db).put(session.id, a.id, null);
    await relayDb.deleteFrom('session_members').where('session_id', '=', session.id).execute();
    await relayDb.deleteFrom('sessions').where('id', '=', session.id).execute();
    const left = await db
      .selectFrom('session_policy')
      .select('session_id')
      .where('session_id', '=', session.id)
      .execute();
    const mutes = await db
      .selectFrom('session_mute')
      .select('member_id')
      .where('session_id', '=', session.id)
      .execute();
    expect([left, mutes]).toEqual([[], []]);
  });
});
