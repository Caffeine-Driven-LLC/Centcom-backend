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
import { randomBytes } from 'node:crypto';
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

  it('a person outside the workspace stays a member only while their session invite stands (B105)', async () => {
    const s = await seed();
    const outsider = await f.users.create({ display_name: 'Visitor' });
    const device = await f.devices.create({ user: outsider.id });
    const member = await f.sessionMembers.create({
      session: s.session.id,
      user: outsider.id,
      device: device.id,
      role: 'editor',
    });
    const live = createPostgresMembership(stack.db);
    // No workspace membership and no invite: not a member.
    expect(await live.lookup(s.session.id, member.id)).toBeNull();
    const invite = newId('inv');
    const grants = db as unknown as {
      insertInto(t: string): { values(v: object): { execute(): Promise<unknown> } };
      updateTable(t: string): {
        set(v: object): { where(c: string, o: string, v: string): { execute(): Promise<unknown> } };
      };
    };
    await grants
      .insertInto('session_invites')
      .values({
        id: invite,
        session_id: s.session.id,
        workspace_id: s.workspace.id,
        role: 'viewer',
        token_hash: Buffer.alloc(32, 9),
        created_by: s.user.id,
        expires_at: new Date(Date.now() + 86_400_000),
        accepted_at: new Date(),
        accepted_by: outsider.id,
      })
      .execute();
    // A viewer grant caps an editor row to viewer.
    expect(await live.lookup(s.session.id, member.id)).toEqual({
      role: 'viewer',
      userId: outsider.id,
      workspaceId: s.workspace.id,
    });
    await grants
      .updateTable('session_invites')
      .set({ role: 'editor' })
      .where('id', '=', invite)
      .execute();
    expect((await live.lookup(s.session.id, member.id))?.role).toBe('editor');
    await grants
      .updateTable('session_invites')
      .set({ revoked_at: new Date() })
      .where('id', '=', invite)
      .execute();
    expect(await live.lookup(s.session.id, member.id)).toBeNull();
  });

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
      session: { state: 'live', mode: 'command_post', maxMembers: 12 },
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

  describe('a share-link guest (B068 guest_member, no device)', () => {
    /** A live link and a guest on it, in a live team session. */
    async function guestOf(opts: { expires?: Date; revoke?: boolean } = {}) {
      const s = await seed();
      const mid = newId('mem');
      const sql = stack.db as unknown as {
        insertInto(t: string): {
          values(v: object): {
            returning(c: string): { executeTakeFirstOrThrow(): Promise<{ id: string }> };
            execute(): Promise<unknown>;
          };
        };
      };
      const link = await sql
        .insertInto('share_link')
        .values({
          session_id: s.session.id,
          token_hash: randomBytes(32), // one byte repeated 32 times collided now and then (a unique index)
          expires_at: opts.expires ?? new Date(Date.now() + 3_600_000),
          max_uses: 5,
          revoked_at: opts.revoke === true ? new Date() : null,
          created_by_member: s.member.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await sql
        .insertInto('guest_member')
        .values({
          member_id: mid,
          session_id: s.session.id,
          share_link_id: link.id,
          name: 'Visitor',
          slot: 3,
        })
        .execute();
      return { ...s, mid };
    }

    it('is a live viewer with its own name and slot, welcomed without a device', async () => {
      const g = await guestOf();
      expect(await createPostgresMembership(stack.db).lookup(g.session.id, g.mid)).toEqual({
        role: 'viewer',
        userId: g.mid,
        workspaceId: g.workspace.id,
      });
      const resolved = await access().access.resolve(g.session.id, g.mid, null);
      expect(resolved).toMatchObject({
        member: { id: g.mid, name: 'Visitor', slot: 3, role: 'viewer' },
        deviceRevoked: false,
        relayAccess: true,
      });
    });

    it('is no member once its link is revoked or expired, or on another session', async () => {
      const revoked = await guestOf({ revoke: true });
      const expired = await guestOf({ expires: new Date(Date.now() - 1000) });
      const live = await guestOf();
      const members = createPostgresMembership(stack.db);
      expect(await members.lookup(revoked.session.id, revoked.mid)).toBeNull();
      expect(await members.lookup(expired.session.id, expired.mid)).toBeNull();
      expect(await members.lookup(live.session.id, revoked.mid)).toBeNull();
      expect(
        (await access().access.resolve(revoked.session.id, revoked.mid, null))?.member,
      ).toBeNull();
    });

    it('is refused with session_full when the room is at the plan cap', async () => {
      const g = await guestOf();
      const rooms = createRoomRegistry();
      const room = rooms.getOrCreate(g.session.id);
      for (let i = 0; i < 50; i++) {
        room.join(fakeConnection(g.session.id), {
          id: newId('mem'),
          sid: g.session.id,
          role: 'editor',
          userId: newId('usr'),
          workspaceId: g.workspace.id,
          name: 'x',
          slot: i,
        });
      }
      await expect(access(rooms).access.resolve(g.session.id, g.mid, null)).rejects.toMatchObject({
        code: 'session_full',
      });
    });
  });
});
