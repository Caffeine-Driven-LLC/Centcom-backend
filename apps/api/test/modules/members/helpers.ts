/**
 * Test helpers for members (B028): an in-memory MemberStore over B027's in-memory workspace
 * store (one state, one transaction at a time, rollback on a throw, live-only reads, and the
 * database's one-owner index as a 23505), and the member and workspace routes on the API's plugin
 * stack, with published messages recorded. Workspaces are arranged with members of every role.
 */
import { newId } from '@centcom/contracts';
import {
  MEMBERSHIP_EVENTS_CHANNEL,
  paginateArray,
  type AuditDb,
  type MembershipEvent,
  type WorkspaceRole,
} from '@centcom/core';
import type { MemberRecord, MemberStore, MemberTx } from '@centcom/db';
import { MembershipService, memberRoutes } from '../../../src/modules/members/index.js';
import {
  KEYS,
  MemoryWorkspaceStore,
  buildWorkspacesApp,
  type Membership,
  type WorkspacesApp,
} from '../workspaces/helpers.js';

export { asKey, asUser } from '../workspaces/helpers.js';

/** An error as `pg` reports one. */
const pgError = (code: string): Error => Object.assign(new Error('database error'), { code });

/** B028's store over the in-memory workspace state. */
export class MemoryMemberStore implements MemberStore {
  /** When set, the next transactions throw these errors first (one per transaction). */
  readonly failNext: Error[] = [];
  /** While set, transactions wait for it, counted in `waiting` (two requests then truly race). */
  gate: Promise<void> | undefined;
  waiting = 0;

  constructor(readonly state: MemoryWorkspaceStore) {}

  #live(workspaceId: string): boolean {
    return this.state.workspaces.get(workspaceId)?.deletedAt === null;
  }

  #record(m: Membership): MemberRecord {
    const profile = this.state.profiles.get(m.userId);
    return {
      id: m.id,
      workspaceId: m.workspaceId,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      displayName: profile?.displayName ?? 'Unknown',
      email: profile?.email ?? 'unknown@example.test',
    };
  }

  #find(workspaceId: string, test: (m: Membership) => boolean): MemberRecord | null {
    if (!this.#live(workspaceId)) return null;
    const m = this.state.memberships.find((x) => x.workspaceId === workspaceId && test(x));
    return m === undefined ? null : this.#record(m);
  }

  #tx(trx: AuditDb): MemberTx {
    return {
      trx,
      lockWorkspace: (workspaceId) => Promise.resolve(this.#live(workspaceId)),
      lockMember: (workspaceId, memberId) =>
        Promise.resolve(this.#find(workspaceId, (m) => m.id === memberId)),
      lockMemberOf: (workspaceId, userId) =>
        Promise.resolve(this.#find(workspaceId, (m) => m.userId === userId)),
      setRole: (memberId, role) => {
        const m = this.state.memberships.find((x) => x.id === memberId);
        if (m === undefined) return Promise.resolve();
        const otherOwner = this.state.memberships.some(
          (x) => x.workspaceId === m.workspaceId && x.role === 'owner' && x.id !== memberId,
        );
        // memberships_workspace_id_owner_key: one owner per workspace, at every statement.
        if (role === 'owner' && otherOwner) return Promise.reject(pgError('23505'));
        m.role = role;
        return Promise.resolve();
      },
      remove: (memberId) => {
        this.state.memberships = this.state.memberships.filter((x) => x.id !== memberId);
        return Promise.resolve();
      },
      add: (input) => {
        const exists = this.state.memberships.some(
          (x) => x.workspaceId === input.workspaceId && x.userId === input.userId,
        );
        if (exists) return Promise.resolve(null);
        this.state.addUser(input.userId);
        this.state.now += 1;
        const m: Membership = { ...input, joinedAt: new Date(this.state.now) };
        this.state.memberships.push(m);
        return Promise.resolve(this.#record(m));
      },
    };
  }

  /** The member operations inside `trx`, a transaction of the shared state (B029's invites). */
  operations(trx: AuditDb): MemberTx {
    return this.#tx(trx);
  }

  async transaction<T>(fn: (tx: MemberTx) => Promise<T>): Promise<T> {
    if (this.gate !== undefined) {
      this.waiting += 1;
      await this.gate;
    }
    return this.state.exclusive(async (trx) => {
      const failure = this.failNext.shift();
      if (failure !== undefined) throw failure;
      return fn(this.#tx(trx));
    });
  }

  list(
    workspaceId: string,
    params: Parameters<MemberStore['list']>[1],
  ): ReturnType<MemberStore['list']> {
    const members = this.#live(workspaceId)
      ? this.state.memberships
          .filter((m) => m.workspaceId === workspaceId)
          .map((m) => this.#record(m))
      : [];
    return Promise.resolve(
      paginateArray(
        members,
        {
          sorts: { joined: { value: (m) => m.joinedAt.toISOString(), direction: 'asc' } },
          id: (m) => m.id,
        },
        params,
      ),
    );
  }

  get(workspaceId: string, memberId: string): Promise<MemberRecord | null> {
    return Promise.resolve(this.#find(workspaceId, (m) => m.id === memberId));
  }

  getLive(workspaceId: string, userId: string): Promise<MemberRecord | null> {
    return Promise.resolve(this.#find(workspaceId, (m) => m.userId === userId));
  }
}

export interface MembersApp extends WorkspacesApp {
  members: MembershipService;
  memberStore: MemoryMemberStore;
  /** `centcom:membership` messages, parsed. */
  membershipEvents(): MembershipEvent[];
}

/** The member and workspace routes over one in-memory state. */
export async function membersApp(options: { failPublish?: boolean } = {}): Promise<MembersApp> {
  const state = new MemoryWorkspaceStore();
  const memberStore = new MemoryMemberStore(state);
  let members: MembershipService | undefined;
  const app = await buildWorkspacesApp(state, state.reader, {
    ...(options.failPublish === undefined ? {} : { failPublish: options.failPublish }),
    beforeReady: async (server, ctx) => {
      members = new MembershipService({
        store: memberStore,
        events: ctx.events,
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
        sleep: () => Promise.resolve(),
      });
      await server.register(memberRoutes, { members, workspaces: state, cursorKeys: KEYS });
    },
  });
  if (members === undefined) throw new Error('membersApp: the member routes were not registered');
  return {
    ...app,
    members,
    memberStore,
    membershipEvents: () =>
      app.published
        .filter((p) => p.channel === MEMBERSHIP_EVENTS_CHANNEL)
        .map((p) => JSON.parse(p.message) as MembershipEvent),
  };
}

/** A workspace with one member of each role; returns their user and membership ids. */
export function arrange(state: MemoryWorkspaceStore): {
  workspaceId: string;
  users: Record<WorkspaceRole, string>;
  mems: Record<WorkspaceRole, string>;
} {
  const workspaceId = newId('wsp');
  const owner = state.addUser();
  state.now += 1;
  state.workspaces.set(workspaceId, {
    id: workspaceId,
    name: 'Acme',
    slug: `acme-${workspaceId.slice(-6).toLowerCase()}`,
    version: 1,
    createdAt: new Date(state.now),
    createdBy: owner,
    deletedAt: null,
  });
  const users = {} as Record<WorkspaceRole, string>;
  const mems = {} as Record<WorkspaceRole, string>;
  for (const role of ['owner', 'admin', 'member', 'billing', 'guest'] as const) {
    const userId = role === 'owner' ? owner : state.addUser();
    users[role] = userId;
    mems[role] = state.join(workspaceId, userId, role);
  }
  return { workspaceId, users, mems };
}

/** The roles of the workspace's members, by user. */
export const rolesOf = (state: MemoryWorkspaceStore, workspaceId: string): Record<string, string> =>
  Object.fromEntries(
    state.memberships.filter((m) => m.workspaceId === workspaceId).map((m) => [m.userId, m.role]),
  );
