/**
 * Factories (B010 acceptance 4): rows that satisfy every constraint of the core schema, distinct
 * emails and strictly increasing ids, the related rows created on the way, the next free session
 * slot, and the very same rows from the same seed and clock on every run. Needs a real stack.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFactories,
  createFakeClock,
  createSeededRandom,
  seededIdGenerator,
  startTestStack,
  userFactory,
  workspaceFactory,
  type TestStack,
} from '../../src/index.js';
import { CONTAINER_TEST_TIMEOUT_MS, STACK } from './helpers.js';

describe.runIf(STACK)('factories', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack({ reuse: true });
  }, CONTAINER_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    await stack.reset();
  });
  afterAll(async () => {
    await stack.stop();
  });

  it('userFactory.create() twice gives distinct emails and strictly increasing ids (acceptance 4)', async () => {
    const users = userFactory(stack.db);
    const first = await users.create();
    const second = await users.create();
    expect(first.email).not.toBe(second.email);
    expect(first.id < second.id).toBe(true);
    expect(first).toMatchObject({ locale: 'en', status: 'active', telemetry_opt_in: false });
    expect(await users.create({ display_name: 'Grace', locale: 'fr' })).toMatchObject({
      display_name: 'Grace',
      locale: 'fr',
    });
  });

  it('gives the same rows from the same seed and clock, run after run (acceptance 4)', async () => {
    const run = async (): Promise<unknown[]> => {
      await stack.reset();
      const clock = createFakeClock('2026-10-07T12:00:00.000Z');
      const random = createSeededRandom('factories');
      const make = createFactories(stack.db, {
        ids: seededIdGenerator(random, clock),
        clock,
        random,
      });
      const owner = await make.users.create();
      const workspace = await make.workspaces.create({ owner });
      const device = await make.devices.create({ user: owner });
      const session = await make.sessions.create({ workspace });
      const member = await make.sessionMembers.create({ session, user: owner, device });
      return [owner, workspace, device, session, member];
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    const [owner] = first as [{ created_at: Date }];
    expect(owner.created_at.toISOString()).toBe('2026-10-07T12:00:00.000Z');

    await stack.reset();
    const other = createFactories(stack.db, {
      ids: seededIdGenerator(
        createSeededRandom('another seed'),
        createFakeClock('2026-10-07T12:00:00.000Z'),
      ),
    });
    expect((await other.users.create()).id).not.toBe((first[0] as { id: string }).id);
  });

  it('creates a workspace with its owner membership, and the owner when none is given', async () => {
    const workspace = await workspaceFactory(stack.db).create();
    const members = await stack.db
      .selectFrom('memberships')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .execute();
    expect(members).toEqual([
      expect.objectContaining({ user_id: workspace.created_by, role: 'owner' }),
    ]);
    expect(workspace.slug).toMatch(/^[a-z0-9-]{3,40}$/);
  });

  it('builds the whole chain for a session member, in the next free slot', async () => {
    const make = createFactories(stack.db);
    const session = await make.sessions.create();
    const slots = [];
    for (let i = 0; i < 3; i++) slots.push((await make.sessionMembers.create({ session })).slot);
    expect(slots).toEqual([0, 1, 2]);
    expect(session.state).toBe('pending');
    const counts = await Promise.all(
      (
        ['users', 'devices', 'workspaces', 'memberships', 'sessions', 'session_members'] as const
      ).map(async (t) =>
        Number(
          (
            await stack.db
              .selectFrom(t)
              .select((eb) => eb.fn.countAll().as('n'))
              .executeTakeFirstOrThrow()
          ).n,
        ),
      ),
    );
    // 1 owner + 3 member users; 3 devices; 1 workspace; 1 owner membership; 1 session; 3 members.
    expect(counts).toEqual([4, 3, 1, 1, 1, 3]);
  });

  it('makes devices whose keys and fingerprint pass the schema, and memberships of any role', async () => {
    const make = createFactories(stack.db);
    const device = await make.devices.create();
    expect(device.x25519_pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device.ed25519_pub).not.toBe(device.x25519_pub);
    expect(device.fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const workspace = await make.workspaces.create();
    for (const role of ['admin', 'member', 'billing', 'guest'] as const) {
      expect((await make.memberships.create({ workspace, role })).role).toBe(role);
    }
  });
});
