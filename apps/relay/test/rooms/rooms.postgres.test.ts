/**
 * The rooms' Postgres reads (B043) on Postgres 16 (B010's test stack: DATABASE_URL and REDIS_URL,
 * or a container runtime):
 *
 * - live membership: the session role, capped by the workspace role (guest → viewer, billing →
 *   none); null once the member left, was removed from the workspace, or the workspace is gone;
 * - `SessionAccess`: unknown session null; the role from the records, never the ticket
 *   (acceptance 7); revoked, unknown or someone else's device; the plan's `relay_access` and
 *   `max_session_members` (unlimited → 50); a slot assigned only to an admitted member; the room's
 *   cap refuses with `session_full` before any slot is taken (acceptance 6);
 * - `effectivePlan` agrees with B069's resolver for every status, before and after its deadline.
 */
import { newId } from '@centcom/contracts';
import { createSessionSlotStore } from '@centcom/db';
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveEntitlements,
  type PlanCatalog,
} from '../../../api/src/modules/entitlements/resolve.js';
import { SEED_PLANS } from '../../../api/src/modules/entitlements/seed-plans.js';
import {
  createPostgresSessionAccess,
  effectivePlan,
  loadSessionEntitlements,
  type AccessDbClient,
} from '../../src/rooms/access.js';
import { createPostgresMembership, LiveMembership } from '../../src/rooms/membership.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { createSlotService } from '../../src/slots/index.js';
import {
  STACK,
  STACK_TIMEOUT_MS,
  startTestStack,
  type SlotDb,
  type TestStack,
} from '../slots/helpers.js';
import { fakeConnection } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('effectivePlan', () => {
  it('agrees with B069’s resolver for every status around its deadline', () => {
    const catalog: PlanCatalog = new Map(
      (['free', 'pro', 'team'] as const).map((id) => [id, SEED_PLANS[id].limits]),
    );
    const now = new Date('2026-10-08T12:00:00Z');
    const around = [new Date(now.getTime() - DAY), new Date(now.getTime() + DAY)];
    for (const status of ['active', 'trialing', 'past_due', 'canceled', 'none'] as const) {
      for (const deadline of around) {
        const grace = status === 'past_due' ? deadline : null;
        const period =
          status === 'canceled'
            ? { start: new Date(now.getTime() - 30 * DAY), end: deadline }
            : null;
        const expected = resolveEntitlements(
          { plan: 'team', status, period, grace_until: grace, addonSeats: 0, now },
          catalog,
        ).plan;
        const actual = effectivePlan(
          { plan_id: 'team', status, grace_until: grace, period_end: period?.end ?? null },
          now,
        );
        expect(actual, `${status} ${deadline.toISOString()}`).toBe(expected);
      }
    }
    expect(effectivePlan(undefined, now)).toBe('free');
  });
});

describe.runIf(STACK)('rooms on Postgres 16', () => {
  let stack: TestStack;
  let db: AccessDbClient;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as AccessDbClient;
    f = createFactories(stack.db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  /** A team workspace (relay included) with a session, and a member in both. */
  async function seed(opts: { plan?: 'free' | 'pro' | 'team'; status?: string } = {}) {
    const workspace = await f.workspaces.create();
    await db
      .insertInto('workspace_entitlements')
      .values({
        workspace_id: workspace.id,
        plan_id: opts.plan ?? 'team',
        status: (opts.status ?? 'active') as 'active',
      })
      .execute();
    const session = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    const user = await f.users.create({ display_name: 'Grace' });
    await f.memberships.create({ workspace: workspace.id, user: user.id, role: 'member' });
    const device = await f.devices.create({ user: user.id });
    const member = await f.sessionMembers.create({
      session: session.id,
      user: user.id,
      device: device.id,
      role: 'editor',
    });
    return { workspace, session, user, device, member };
  }

  function access(rooms = createRoomRegistry()) {
    const membership = new LiveMembership({ source: createPostgresMembership(stack.db) });
    const slots = createSlotService(createSessionSlotStore(stack.db as unknown as SlotDb));
    return {
      rooms,
      membership,
      slots,
      access: createPostgresSessionAccess({ db, membership, slots, rooms }),
    };
  }

  it('reads the live member: role from the records, capped by the workspace role', async () => {
    const s = await seed();
    const live = createPostgresMembership(stack.db);
    expect(await live.lookup(s.session.id, s.member.id)).toEqual({
      role: 'editor',
      userId: s.user.id,
      workspaceId: s.workspace.id,
    });
    await db
      .updateTable('memberships')
      .set({ role: 'guest' })
      .where('user_id', '=', s.user.id)
      .execute();
    expect((await live.lookup(s.session.id, s.member.id))?.role).toBe('viewer');
    await db
      .updateTable('memberships')
      .set({ role: 'billing' })
      .where('user_id', '=', s.user.id)
      .execute();
    expect(await live.lookup(s.session.id, s.member.id)).toBeNull();
    await db.deleteFrom('memberships').where('user_id', '=', s.user.id).execute();
    expect(await live.lookup(s.session.id, s.member.id)).toBeNull();
  });

  it('answers null once the member left or the workspace is deleted', async () => {
    const left = await seed();
    await db
      .updateTable('session_members')
      .set({ left_at: new Date() })
      .where('id', '=', left.member.id)
      .execute();
    const live = createPostgresMembership(stack.db);
    expect(await live.lookup(left.session.id, left.member.id)).toBeNull();
    const gone = await seed();
    await db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', gone.workspace.id)
      .execute();
    expect(await live.lookup(gone.session.id, gone.member.id)).toBeNull();
    expect(await live.lookup(gone.session.id, newId('mem'))).toBeNull();
  });

  it('resolves a hello from the records, never the ticket (acceptance 7)', async () => {
    const s = await seed();
    const { access: a, slots } = access();
    expect(await a.resolve(newId('ses'), s.member.id, s.device.id)).toBeNull();
    await db
      .updateTable('session_members')
      .set({ role: 'viewer' })
      .where('id', '=', s.member.id)
      .execute();
    const result = await a.resolve(s.session.id, s.member.id, s.device.id);
    expect(result).toEqual({
      session: { state: 'live', maxMembers: 12 },
      member: { id: s.member.id, name: 'Grace', slot: 0, role: 'viewer' },
      deviceRevoked: false,
      relayAccess: true,
    });
    expect(await slots.get(s.session.id, s.member.id)).toBe(0);
  });

  it('flags a revoked, unknown or someone else’s device, and assigns no slot then', async () => {
    const s = await seed();
    const other = await f.devices.create();
    const { access: a, slots } = access();
    expect((await a.resolve(s.session.id, s.member.id, other.id))?.deviceRevoked).toBe(true);
    expect((await a.resolve(s.session.id, s.member.id, newId('dev')))?.deviceRevoked).toBe(true);
    await db
      .updateTable('devices')
      .set({ revoked_at: new Date() })
      .where('id', '=', s.device.id)
      .execute();
    expect((await a.resolve(s.session.id, s.member.id, s.device.id))?.deviceRevoked).toBe(true);
    expect(await slots.get(s.session.id, s.member.id)).toBeNull();
  });

  it('reads the plan: no relay on free, a lapsed subscription is free, caps at 50', async () => {
    const free = await seed({ plan: 'free', status: 'none' });
    expect(await loadSessionEntitlements(db, free.workspace.id, new Date())).toEqual({
      relayAccess: false,
      maxSessionMembers: 8,
    });
    const lapsed = await seed({ plan: 'team', status: 'canceled' });
    expect((await loadSessionEntitlements(db, lapsed.workspace.id, new Date())).relayAccess).toBe(
      false,
    );
    expect(await loadSessionEntitlements(db, null, new Date())).toMatchObject({
      relayAccess: false,
    });
    const { access: a } = access();
    expect((await a.resolve(free.session.id, free.member.id, free.device.id))?.relayAccess).toBe(
      false,
    );
    // An unlimited plan is still capped at 50 members.
    const pro = await seed({ plan: 'pro', status: 'active' });
    await db
      .updateTable('plan_limits')
      .set({ int_value: null })
      .where('plan_id', '=', 'pro')
      .where('key', '=', 'max_session_members')
      .execute();
    expect(await loadSessionEntitlements(db, pro.workspace.id, new Date())).toEqual({
      relayAccess: true,
      maxSessionMembers: 50,
    });
  });

  it('refuses a new member of a full room with session_full before taking a slot (acceptance 6)', async () => {
    const s = await seed({ plan: 'free', status: 'none' });
    await db
      .insertInto('plan_limits')
      .values({ plan_id: 'free', key: 'relay_access', bool_value: true })
      .onConflict((oc) => oc.columns(['plan_id', 'key']).doUpdateSet({ bool_value: true }))
      .execute();
    try {
      const { access: a, rooms, slots } = access();
      const room = rooms.getOrCreate(s.session.id);
      for (let i = 0; i < 8; i++) {
        room.join(fakeConnection(s.session.id), {
          id: newId('mem'),
          sid: s.session.id,
          role: 'editor',
          userId: newId('usr'),
          workspaceId: s.workspace.id,
          name: 'x',
          slot: i,
        });
      }
      await expect(a.resolve(s.session.id, s.member.id, s.device.id)).rejects.toMatchObject({
        code: 'session_full',
        status: 403,
      });
      expect(await slots.get(s.session.id, s.member.id)).toBeNull();
    } finally {
      await db
        .updateTable('plan_limits')
        .set({ bool_value: false })
        .where('plan_id', '=', 'free')
        .where('key', '=', 'relay_access')
        .execute();
    }
  });
});
