/**
 * Members of a workspace (B028, CT-API-WORKSPACES): list, change a role, remove (or leave),
 * transfer ownership, and `add` for other lanes (accepting an invite, B029).
 *
 * - Whether the caller may act is B021's RBAC, asked by the routes with the target as they read
 *   it. Each change then locks the target's row and fails with 409 if its role moved in between,
 *   so a decision is never applied to a member who changed since.
 * - One owner, always: the owner cannot be removed or leave (409, transfer first) and is never
 *   given by a role change. A transfer locks the workspace row, checks the caller is still the
 *   owner (409 when another transfer won) and the target is an admin (422 otherwise), then
 *   demotes the owner to admin before it promotes the target, in one transaction (a deadlock is
 *   retried once, then 409). The database's unique index backs this up.
 * - Every change writes its audit event in its transaction; after the commit it is announced on
 *   `centcom:membership` and cached roles are dropped.
 *
 * Owns: the rules above. Must not: decide who may act (RBAC does), touch another workspace's
 * memberships, or announce before the commit.
 */
import { newId as makeId } from '@centcom/contracts';
import {
  AppError,
  conflict,
  notFound,
  type Logger,
  type MembershipEvent,
  type Metrics,
  type Page,
  type PageParams,
  type PubSub,
  type WorkspaceRole,
} from '@centcom/core';
import type { MemberRecord, MemberStore, MemberTx } from '@centcom/db';
import type { RequestCtx } from '../workspaces/service.js';
import { announceMembershipChanges } from './events.js';
import type { AssignableRole } from './input.js';

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const MEMBER_DETAILS = Object.freeze({
  notFound: 'There is no such member.',
  changed: 'The member changed since you read them; read them again.',
  ownerStays: 'The owner cannot leave or be removed; transfer ownership first.',
  notOwner: 'Ownership was transferred by someone else meanwhile.',
  targetNotAdmin: 'Ownership can only go to an admin of the workspace.',
  transferToSelf: 'You are already the owner.',
  busy: 'The workspace is busy; try again.',
  exists: 'That user is already a member.',
} as const);

/** SQLSTATE `deadlock_detected`. */
const DEADLOCK = '40P01';

/** Options for MembershipService. */
export interface MembershipServiceOptions {
  store: MemberStore;
  /** Announces changes and drops cached roles (B009 `RedisBackend.pubsub`). */
  events: PubSub;
  /** Makes `mem_` ids; default CT-IDS `newId`. */
  newId?: () => string;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Waits between publish retries; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Writes `membership.*` lines (ids only). */
  logger?: Logger;
  /** Receives `membership_event_publish_failed_total{channel}`. */
  metrics?: Metrics;
}

/** Members of workspaces. */
export class MembershipService {
  readonly #o: MembershipServiceOptions;
  readonly #clock: () => number;

  constructor(options: MembershipServiceOptions) {
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
  }

  /** One page of the workspace's members, oldest first. */
  list(workspaceId: string, params: PageParams): Promise<Page<MemberRecord>> {
    return this.#o.store.list(workspaceId, params);
  }

  /** The member, or null. */
  get(workspaceId: string, memberId: string): Promise<MemberRecord | null> {
    return this.#o.store.get(workspaceId, memberId);
  }

  /** `userId`'s membership as it is now (never cached), or null. */
  getLive(workspaceId: string, userId: string): Promise<MemberRecord | null> {
    return this.#o.store.getLive(workspaceId, userId);
  }

  /**
   * Adds `userId` with `role` in `tx` (the caller's transaction) and writes `member.add`. Throws
   * 409 `member_exists` when they already are a member. No announcement: a new member has no
   * role to drop yet.
   */
  async add(
    tx: MemberTx,
    workspaceId: string,
    userId: string,
    role: AssignableRole,
    ctx: RequestCtx,
    via: 'invite' | 'direct' = 'invite',
  ): Promise<MemberRecord> {
    const id = (this.#o.newId ?? (() => makeId('mem')))();
    const added = await tx.add({ id, workspaceId, userId, role });
    if (added === null) throw new AppError('member_exists', { detail: MEMBER_DETAILS.exists });
    await ctx.audit(tx.trx, {
      action: 'member.add',
      workspaceId,
      target: { type: 'membership', id },
      meta: { user_id: userId, role, via },
    });
    return added;
  }

  /**
   * Gives the member `role`, if their role is still `expectedRole` (409 otherwise; 404 when they
   * are gone). The same role again changes nothing.
   */
  async changeRole(
    workspaceId: string,
    memberId: string,
    role: AssignableRole,
    expectedRole: WorkspaceRole,
    ctx: RequestCtx,
  ): Promise<MemberRecord> {
    const { target, changed } = await this.#o.store.transaction(async (tx) => {
      const locked = await tx.lockMember(workspaceId, memberId);
      if (locked === null) throw notFound(MEMBER_DETAILS.notFound);
      if (locked.role !== expectedRole) throw conflict(MEMBER_DETAILS.changed);
      if (locked.role === 'owner') throw conflict(MEMBER_DETAILS.ownerStays);
      if (locked.role === role) return { target: locked, changed: false };
      await tx.setRole(memberId, role);
      await ctx.audit(tx.trx, {
        action: 'member.role_change',
        workspaceId,
        target: { type: 'membership', id: memberId },
        meta: { user_id: locked.userId, from_role: locked.role, to_role: role },
      });
      return { target: locked, changed: true };
    });
    if (!changed) return target;
    await this.#announce([this.#event('role_changed', target, role)]);
    return { ...target, role };
  }

  /**
   * Removes the member, if their role is still `expectedRole` (409 otherwise; 404 when they are
   * gone; 409 for the owner). `self` says the member is leaving.
   */
  async remove(
    workspaceId: string,
    memberId: string,
    expectedRole: WorkspaceRole,
    self: boolean,
    ctx: RequestCtx,
  ): Promise<void> {
    const removed = await this.#o.store.transaction(async (tx) => {
      // Owner changes take turns on the workspace row: a removal cannot race a transfer.
      if (!(await tx.lockWorkspace(workspaceId))) throw notFound(MEMBER_DETAILS.notFound);
      const target = await tx.lockMember(workspaceId, memberId);
      if (target === null) throw notFound(MEMBER_DETAILS.notFound);
      if (target.role === 'owner') throw conflict(MEMBER_DETAILS.ownerStays);
      if (target.role !== expectedRole) throw conflict(MEMBER_DETAILS.changed);
      await tx.remove(memberId);
      await ctx.audit(tx.trx, {
        action: 'member.remove',
        workspaceId,
        target: { type: 'membership', id: memberId },
        meta: { user_id: target.userId, role: target.role, self },
      });
      return target;
    });
    await this.#announce([this.#event(self ? 'left' : 'removed', removed)]);
  }

  /**
   * Makes the admin `toMemberId` the owner and `ownerUserId` (the caller, the owner) an admin.
   * Throws 404 when the target is gone, 422 when it is not an admin (or is the caller), and 409
   * when the caller is no longer the owner (another transfer won) or after a second deadlock.
   */
  async transferOwnership(
    workspaceId: string,
    toMemberId: string,
    ownerUserId: string,
    ctx: RequestCtx,
  ): Promise<void> {
    const run = () =>
      this.#o.store.transaction(async (tx) => {
        if (!(await tx.lockWorkspace(workspaceId))) throw notFound(MEMBER_DETAILS.notFound);
        const owner = await tx.lockMemberOf(workspaceId, ownerUserId);
        if (owner?.role !== 'owner') throw conflict(MEMBER_DETAILS.notOwner);
        const target = await tx.lockMember(workspaceId, toMemberId);
        if (target === null) throw notFound(MEMBER_DETAILS.notFound);
        if (target.id === owner.id) throw unprocessable(MEMBER_DETAILS.transferToSelf);
        if (target.role !== 'admin') throw unprocessable(MEMBER_DETAILS.targetNotAdmin);
        // Demote first: the database allows one owner per workspace at every statement.
        await tx.setRole(owner.id, 'admin');
        await tx.setRole(target.id, 'owner');
        for (const [member, from, to] of [
          [owner, 'owner', 'admin'],
          [target, 'admin', 'owner'],
        ] as const) {
          await ctx.audit(tx.trx, {
            action: 'member.role_change',
            workspaceId,
            target: { type: 'membership', id: member.id },
            meta: { user_id: member.userId, from_role: from, to_role: to },
          });
        }
        return { owner, target };
      });
    let changed: { owner: MemberRecord; target: MemberRecord };
    try {
      changed = await run();
    } catch (err) {
      if (!isDeadlock(err)) throw err;
      try {
        changed = await run();
      } catch (again) {
        if (isDeadlock(again)) throw conflict(MEMBER_DETAILS.busy);
        throw again;
      }
    }
    await this.#announce([
      this.#event('role_changed', changed.owner, 'admin'),
      this.#event('role_changed', changed.target, 'owner'),
    ]);
  }

  #event(
    type: MembershipEvent['type'],
    member: MemberRecord,
    role?: WorkspaceRole,
  ): MembershipEvent {
    return {
      type,
      wsp: member.workspaceId,
      mem: member.id,
      user: member.userId,
      ...(role === undefined ? {} : { role }),
      at: new Date(this.#clock()).toISOString(),
    };
  }

  #announce(events: MembershipEvent[]): Promise<void> {
    return announceMembershipChanges(
      {
        events: this.#o.events,
        ...(this.#o.logger === undefined ? {} : { logger: this.#o.logger }),
        ...(this.#o.metrics === undefined ? {} : { metrics: this.#o.metrics }),
        ...(this.#o.sleep === undefined ? {} : { sleep: this.#o.sleep }),
      },
      events,
    );
  }
}

const isDeadlock = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === DEADLOCK;

const unprocessable = (detail: string): AppError =>
  new AppError('validation_failed', {
    detail,
    errors: [{ pointer: '/to_member', code: 'invalid_value', detail }],
  });
