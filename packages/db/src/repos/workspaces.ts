/**
 * Workspaces (B027): the Postgres side of workspace CRUD and purge.
 *
 * - `transaction(fn)` runs `fn` with the operations a change needs, in one transaction (B007's
 *   `withTransaction`, which retries serialization failures); `fn`'s audit events join it.
 * - Reads see live workspaces only: a soft-deleted one is gone for every caller at once.
 * - `purge` removes a soft-deleted workspace for good: its audit events (through
 *   `purge_audit_events`, the one way they leave), sessions, memberships, then the row. It is
 *   idempotent, and refuses a live workspace.
 *
 * Owns: the SQL of workspaces. Must not: return a soft-deleted workspace from a read, purge a live
 * one, or delete audit events any other way.
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

/** A workspace row, as callers see it. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  /** Moves on with every change: the ETag's source. */
  version: number;
  createdAt: Date;
}

/** A live workspace with the caller's view of it. */
export interface WorkspaceView extends WorkspaceRecord {
  /** The caller's role; null for a caller that is not a member (an API key of the workspace). */
  role: WorkspaceRole | null;
  /** The `usr_` id of the owner. */
  ownerId: string | null;
  memberCount: number;
}

/** A workspace to create, with its owner. */
export interface NewWorkspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  /** The `mem_` id of the owner's membership. */
  membershipId: string;
}

/** The operations of one transaction. */
export interface WorkspaceTx {
  /**
   * The transaction itself: audit events written through it commit or roll back with the change,
   * and a PATCH extension runs its own queries in it (`executeQuery` of a compiled query).
   */
  readonly trx: AuditDb;
  /** Locks the user's row until commit, so one user's creates take turns; false if there is no such user. */
  lockUser(userId: string): Promise<boolean>;
  /** Live workspaces `userId` owns. */
  countOwned(userId: string): Promise<number>;
  /** Slugs in use (by live or deleted workspaces) that are `base` or `base-<suffix>`. */
  slugsLike(base: string): Promise<string[]>;
  /** Inserts the workspace and its owner membership; null, writing nothing, when the slug is taken. */
  insert(input: NewWorkspace): Promise<WorkspaceRecord | null>;
  /** The live workspace, its row locked until commit; null when there is none. */
  lockLive(workspaceId: string): Promise<WorkspaceRecord | null>;
  /** Applies `changes` and moves the version on (lock the row with `lockLive` first). */
  update(workspaceId: string, changes: { name?: string }): Promise<WorkspaceRecord>;
  /** Hides the workspace from every read and moves the version on. */
  softDelete(workspaceId: string): Promise<void>;
}

/** Workspace persistence. */
export interface WorkspaceStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  /** The live workspace as `userId` sees it, or null when it is gone or they are not a member. */
  findForMember(workspaceId: string, userId: string): Promise<WorkspaceView | null>;
  /** The live workspace without a member's view (for API keys), or null. */
  findLive(workspaceId: string): Promise<WorkspaceView | null>;
  /** One page of the live workspaces `userId` is a member of, newest first (sort `created`). */
  listForMember(userId: string, params: PageParams): Promise<Page<WorkspaceView>>;
  /**
   * Removes a soft-deleted workspace and everything that references it; `purged` is false when it
   * was already gone. Throws for a live workspace.
   */
  purge(workspaceId: string): Promise<{ purged: boolean }>;
}

/** Audit events deleted per call while purging (purge_audit_events allows up to 10 000). */
export const PURGE_AUDIT_BATCH = 5000;
/** The sorts of `listForMember`. */
export const WORKSPACE_LIST_SORTS = ['created'] as const;

type Db = Kysely<CoreDatabase> | Transaction<CoreDatabase>;

const RECORD_COLUMNS = [
  'workspaces.id',
  'workspaces.name',
  'workspaces.slug',
  'workspaces.version',
  'workspaces.created_at',
] as const;

const toRecord = (row: {
  id: string;
  name: string;
  slug: string;
  version: number;
  created_at: Date;
}): WorkspaceRecord => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  version: row.version,
  createdAt: row.created_at,
});

/**
 * Live workspaces with their owner and member count, and `userId`'s membership role (null when
 * there is no `userId` or no membership; add `where mine.user_id is not null` to list only theirs).
 */
function views(db: Db, userId: string | null) {
  return db
    .selectFrom('workspaces')
    .leftJoin('memberships as mine', (join) =>
      userId === null
        ? join.onRef('mine.workspace_id', '=', 'workspaces.id').on(sql<boolean>`false`)
        : join.onRef('mine.workspace_id', '=', 'workspaces.id').on('mine.user_id', '=', userId),
    )
    .select(RECORD_COLUMNS)
    .select('mine.role')
    .select((eb) => [
      eb
        .selectFrom('memberships as owners')
        .select('owners.user_id')
        .whereRef('owners.workspace_id', '=', 'workspaces.id')
        .where('owners.role', '=', 'owner')
        .limit(1)
        .as('owner_id'),
      eb
        .selectFrom('memberships as everyone')
        .select((count) => count.fn.countAll<string>().as('n'))
        .whereRef('everyone.workspace_id', '=', 'workspaces.id')
        .as('member_count'),
    ])
    .where('workspaces.deleted_at', 'is', null);
}

const toView = (row: {
  id: string;
  name: string;
  slug: string;
  version: number;
  created_at: Date;
  role: string | null;
  owner_id: string | null;
  member_count: string | number | bigint | null;
}): WorkspaceView => ({
  ...toRecord(row),
  role: isWorkspaceRole(row.role) ? row.role : null,
  ownerId: row.owner_id,
  memberCount: Number(row.member_count ?? 0),
});

function txOperations(trx: Transaction<CoreDatabase>): WorkspaceTx {
  return {
    trx,
    async lockUser(userId) {
      const row = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      return row !== undefined;
    },
    async countOwned(userId) {
      const row = await trx
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('memberships.user_id', '=', userId)
        .where('memberships.role', '=', 'owner')
        .where('workspaces.deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },
    async slugsLike(base) {
      // `base` is [a-z0-9-] only, so it holds no LIKE wildcards.
      const rows = await trx
        .selectFrom('workspaces')
        .select('slug')
        .where((eb) => eb.or([eb('slug', '=', base), eb('slug', 'like', `${base}-%`)]))
        .execute();
      return rows.map((r) => r.slug);
    },
    async insert(input) {
      // A taken slug is no error here: the transaction stays usable for the next candidate.
      const row = await trx
        .insertInto('workspaces')
        .values({ id: input.id, name: input.name, slug: input.slug, created_by: input.ownerId })
        .onConflict((oc) => oc.column('slug').doNothing())
        .returning(['id', 'name', 'slug', 'version', 'created_at'])
        .executeTakeFirst();
      if (row === undefined) return null;
      await trx
        .insertInto('memberships')
        .values({
          id: input.membershipId,
          workspace_id: input.id,
          user_id: input.ownerId,
          role: 'owner',
        })
        .execute();
      return toRecord(row);
    },
    async lockLive(workspaceId) {
      const row = await trx
        .selectFrom('workspaces')
        .select(['id', 'name', 'slug', 'version', 'created_at'])
        .where('id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async update(workspaceId, changes) {
      const row = await trx
        .updateTable('workspaces')
        .set({
          ...(changes.name === undefined ? {} : { name: changes.name }),
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', workspaceId)
        .returning(['id', 'name', 'slug', 'version', 'created_at'])
        .executeTakeFirstOrThrow();
      return toRecord(row);
    },
    async softDelete(workspaceId) {
      await trx
        .updateTable('workspaces')
        .set({
          deleted_at: sql<Date>`now()`,
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .execute();
    },
  };
}

/** Workspace persistence over `database` (any database type holding the core tables). */
export function createWorkspaceStore<DB extends CoreDatabase>(
  database: Kysely<DB>,
): WorkspaceStore {
  // Only the core tables are touched; Kysely's types are invariant in the database type.
  const db = database as unknown as Kysely<CoreDatabase>;
  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(txOperations(trx))),

    async findForMember(workspaceId, userId) {
      const row = await views(db, userId)
        .where('workspaces.id', '=', workspaceId)
        .where('mine.user_id', 'is not', null)
        .executeTakeFirst();
      return row === undefined ? null : toView(row);
    },

    async findLive(workspaceId) {
      const row = await views(db, null).where('workspaces.id', '=', workspaceId).executeTakeFirst();
      return row === undefined ? null : toView(row);
    },

    async listForMember(userId, params) {
      const result = await paginate(
        views(db, userId).where('mine.user_id', 'is not', null),
        {
          sorts: { created: { column: 'workspaces.created_at', direction: 'desc' } },
          idColumn: 'workspaces.id',
        },
        params,
      );
      return { ...result, data: result.data.map(toView) };
    },

    async purge(workspaceId) {
      return withTransaction(db, async (trx) => {
        const row = await trx
          .selectFrom('workspaces')
          .select('deleted_at')
          .where('id', '=', workspaceId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { purged: false };
        if (row.deleted_at === null) {
          throw new Error('purge: the workspace is live; only a deleted workspace is purged');
        }
        // Audit events leave only through the retention function, in batches.
        for (;;) {
          const result = await sql<{ purged: number }>`
            select purge_audit_events(${workspaceId}, 'infinity'::timestamptz, ${PURGE_AUDIT_BATCH})
              as purged
          `.execute(trx);
          if ((result.rows[0]?.purged ?? 0) < PURGE_AUDIT_BATCH) break;
        }
        const sessions = trx
          .selectFrom('sessions')
          .select('id')
          .where('workspace_id', '=', workspaceId);
        await trx.deleteFrom('session_members').where('session_id', 'in', sessions).execute();
        await trx.deleteFrom('sessions').where('workspace_id', '=', workspaceId).execute();
        await trx.deleteFrom('memberships').where('workspace_id', '=', workspaceId).execute();
        await trx.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
        return { purged: true };
      });
    },
  };
}
