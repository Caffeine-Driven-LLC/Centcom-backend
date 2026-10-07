/**
 * Workspace members (B028): the Postgres side of member management.
 *
 * - `transaction(fn)` runs `fn` with the operations a change needs, in one transaction (B007's
 *   `withTransaction`). Owner changes lock the workspace row first, so they take turns; changes
 *   to one member lock that member's row. `fn`'s audit events join the transaction.
 * - `memberOperations(trx)` gives the same operations inside a transaction another lane holds
 *   (accepting an invite, B029).
 * - Reads see members of live workspaces only, with the user's name and e-mail address (who may
 *   see the address is the API's decision).
 *
 * One owner per workspace is the database's rule (B027's `memberships_workspace_id_owner_key`):
 * a transfer demotes the old owner before it promotes the new one.
 *
 * Owns: the SQL of memberships. Must not: touch another workspace's memberships, or the user.
 */
import {
  isWorkspaceRole,
  paginate,
  type AuditDb,
  type Page,
  type PageParams,
  type WorkspaceRole,
} from '@centcom/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { CoreDatabase } from '../schema/core.js';
import { withTransaction } from '../tx.js';

/** A member of a workspace. */
export interface MemberRecord {
  /** `mem_` id. */
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: Date;
  displayName: string;
  /** The user's address: the API shows it to owners and admins only. */
  email: string;
}

/** A member to add. */
export interface NewMember {
  /** `mem_` id. */
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/** The operations of one transaction. */
export interface MemberTx {
  /** The transaction itself: audit events written through it commit with the change. */
  readonly trx: AuditDb;
  /** Locks the live workspace's row until commit (owner changes take turns); false when it is gone. */
  lockWorkspace(workspaceId: string): Promise<boolean>;
  /** The member of the workspace, its row locked until commit; null when there is none. */
  lockMember(workspaceId: string, memberId: string): Promise<MemberRecord | null>;
  /** `userId`'s membership of the workspace, its row locked; null when they are not a member. */
  lockMemberOf(workspaceId: string, userId: string): Promise<MemberRecord | null>;
  setRole(memberId: string, role: WorkspaceRole): Promise<void>;
  remove(memberId: string): Promise<void>;
  /** Adds a member; null, writing nothing, when the user already is one. */
  add(input: NewMember): Promise<MemberRecord | null>;
}

/** Member persistence. */
export interface MemberStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: MemberTx) => Promise<T>): Promise<T>;
  /** One page of a live workspace's members, oldest first (sort `joined`). */
  list(workspaceId: string, params: PageParams): Promise<Page<MemberRecord>>;
  /** The member of a live workspace, or null. */
  get(workspaceId: string, memberId: string): Promise<MemberRecord | null>;
  /** `userId`'s membership of a live workspace, read now (never cached), or null. */
  getLive(workspaceId: string, userId: string): Promise<MemberRecord | null>;
}

/** The sorts of `list`. */
export const MEMBER_LIST_SORTS = ['joined'] as const;

type Db = Kysely<CoreDatabase> | Transaction<CoreDatabase>;

/** Members of live workspaces, with their users' names and addresses. */
function members(db: Db) {
  return db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
    .select([
      'memberships.id',
      'memberships.workspace_id',
      'memberships.user_id',
      'memberships.role',
      'memberships.created_at',
      'users.display_name',
      sql<string>`users.email::text`.as('email'),
    ])
    .where('workspaces.deleted_at', 'is', null);
}

const toRecord = (row: {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: Date;
  display_name: string;
  email: string;
}): MemberRecord => {
  if (!isWorkspaceRole(row.role)) throw new TypeError('members: a row holds an unknown role');
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.created_at,
    displayName: row.display_name,
    email: row.email,
  };
};

/** Membership operations inside `trx`, a transaction the caller holds. */
export function memberOperations(trx: Transaction<CoreDatabase>): MemberTx {
  return {
    trx,
    async lockWorkspace(workspaceId) {
      const row = await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      return row !== undefined;
    },
    async lockMember(workspaceId, memberId) {
      const row = await members(trx)
        .where('memberships.id', '=', memberId)
        .where('memberships.workspace_id', '=', workspaceId)
        .forUpdate('memberships')
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async lockMemberOf(workspaceId, userId) {
      const row = await members(trx)
        .where('memberships.user_id', '=', userId)
        .where('memberships.workspace_id', '=', workspaceId)
        .forUpdate('memberships')
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async setRole(memberId, role) {
      await trx.updateTable('memberships').set({ role }).where('id', '=', memberId).execute();
    },
    async remove(memberId) {
      await trx.deleteFrom('memberships').where('id', '=', memberId).execute();
    },
    async add(input) {
      const inserted = await trx
        .insertInto('memberships')
        .values({
          id: input.id,
          workspace_id: input.workspaceId,
          user_id: input.userId,
          role: input.role,
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) return null;
      const row = await members(trx).where('memberships.id', '=', input.id).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
  };
}

/** Member persistence over `database` (any database type holding the core tables). */
export function createMemberStore<DB extends CoreDatabase>(database: Kysely<DB>): MemberStore {
  // Only the core tables are touched; Kysely's types are invariant in the database type.
  const db = database as unknown as Kysely<CoreDatabase>;
  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(memberOperations(trx))),

    async list(workspaceId, params) {
      const result = await paginate(
        members(db).where('memberships.workspace_id', '=', workspaceId),
        {
          sorts: { joined: { column: 'memberships.created_at', direction: 'asc' } },
          idColumn: 'memberships.id',
        },
        params,
      );
      return { ...result, data: result.data.map(toRecord) };
    },

    async get(workspaceId, memberId) {
      const row = await members(db)
        .where('memberships.id', '=', memberId)
        .where('memberships.workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async getLive(workspaceId, userId) {
      const row = await members(db)
        .where('memberships.user_id', '=', userId)
        .where('memberships.workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
  };
}
