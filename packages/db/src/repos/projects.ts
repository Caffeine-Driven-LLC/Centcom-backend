/**
 * Workspace projects (B035): the Postgres side.
 *
 * - A project belongs to one workspace; reads and locks see projects of live workspaces only, so
 *   a workspace deleted mid-request hides its projects at once.
 * - Names are unique per workspace ignoring case (`projects_workspace_id_name_key`): an insert or
 *   rename that collides returns null, never a raw unique violation, so concurrent creates of one
 *   name give one project and one 409.
 * - `transaction(fn)` runs `fn` with the operations a change needs, in one transaction; a change
 *   locks the row first and moves `version` (the ETag) on.
 * - A purged workspace's projects go through `deleteForWorkspace` (B027's purge hook), as the
 *   foreign key restricts.
 *
 * Owns: the SQL of projects. Must not: interpret `repo_ref` (it is opaque; the API checks it).
 */
import { paginate, type AuditDb, type Page, type PageParams } from '@centcom/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ProjectDatabase } from '../schema/projects.js';
import { withTransaction } from '../tx.js';

/** The unique index on a workspace's names, ignoring case. */
export const PROJECTS_NAME_KEY = 'projects_workspace_id_name_key';

/** A project, as callers see it. */
export interface ProjectRecord {
  /** `prj_` id. */
  id: string;
  workspaceId: string;
  name: string;
  /** Opaque repository reference, or null. */
  repoRef: string | null;
  createdBy: string;
  /** The ETag source; 1 on insert, moved on by every change. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A project to insert. */
export interface NewProject {
  id: string;
  workspaceId: string;
  name: string;
  repoRef: string | null;
  createdBy: string;
}

/** The fields a change may set; absent fields stay as they are. */
export interface ProjectChanges {
  name?: string;
  repoRef?: string | null;
}

/** The operations of one transaction. */
export interface ProjectTx {
  /** The transaction itself: audit events written through it commit with the change. */
  readonly trx: AuditDb;
  /** Whether the workspace is live; its row is share-locked until commit, so it stays live. */
  lockLiveWorkspace(workspaceId: string): Promise<boolean>;
  /** Inserts the project; null, writing nothing, when the workspace has the name (ignoring case). */
  insert(input: NewProject): Promise<ProjectRecord | null>;
  /** The project of a live workspace, its row locked until commit; null when there is none. */
  lockById(projectId: string): Promise<ProjectRecord | null>;
  /**
   * Applies `changes` and moves the version on (lock the row with `lockById` first); null when the
   * new name is taken in the workspace, in which case the transaction must not go on.
   */
  update(projectId: string, changes: ProjectChanges): Promise<ProjectRecord | null>;
  /** Deletes the project. */
  delete(projectId: string): Promise<void>;
}

/** Project persistence. */
export interface ProjectStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: ProjectTx) => Promise<T>): Promise<T>;
  /** One page of the workspace's projects, oldest first (sort `created`). */
  list(workspaceId: string, params: PageParams): Promise<Page<ProjectRecord>>;
  /** The project of a live workspace, or null. */
  findById(projectId: string): Promise<ProjectRecord | null>;
  /**
   * Deletes the projects of a soft-deleted workspace (B027's purge hook); returns how many. Does
   * nothing for a live workspace.
   */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

/** The sorts of `list`. */
export const PROJECT_LIST_SORTS = ['created'] as const;

type Db = Kysely<ProjectDatabase> | Transaction<ProjectDatabase>;

const COLUMNS = [
  'projects.id',
  'projects.workspace_id',
  'projects.name',
  'projects.repo_ref',
  'projects.created_by',
  'projects.version',
  'projects.created_at',
  'projects.updated_at',
] as const;

/** Projects of live workspaces. */
function projects(db: Db) {
  return db
    .selectFrom('projects')
    .innerJoin('workspaces', 'workspaces.id', 'projects.workspace_id')
    .select(COLUMNS)
    .where('workspaces.deleted_at', 'is', null);
}

const toRecord = (row: {
  id: string;
  workspace_id: string;
  name: string;
  repo_ref: string | null;
  created_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}): ProjectRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  repoRef: row.repo_ref,
  createdBy: row.created_by,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** True for the unique violation of a taken name. */
function isNameTaken(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === PROJECTS_NAME_KEY;
}

/** Project operations inside `trx`, a transaction the caller holds. */
export function projectOperations(trx: Transaction<ProjectDatabase>): ProjectTx {
  return {
    trx,
    async lockLiveWorkspace(workspaceId) {
      const row = await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .forShare()
        .executeTakeFirst();
      return row !== undefined;
    },
    async insert(input) {
      const inserted = await trx
        .insertInto('projects')
        .values({
          id: input.id,
          workspace_id: input.workspaceId,
          name: input.name,
          repo_ref: input.repoRef,
          created_by: input.createdBy,
        })
        // The only other unique key is the primary key, a fresh ULID.
        .onConflict((oc) => oc.doNothing())
        .returning(COLUMNS)
        .executeTakeFirst();
      return inserted === undefined ? null : toRecord(inserted);
    },
    async lockById(projectId) {
      const row = await projects(trx)
        .where('projects.id', '=', projectId)
        .forUpdate('projects')
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async update(projectId, changes) {
      try {
        const row = await trx
          .updateTable('projects')
          .set({
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.repoRef === undefined ? {} : { repo_ref: changes.repoRef }),
            version: sql<number>`version + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', projectId)
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        return toRecord(row);
      } catch (err) {
        if (isNameTaken(err)) return null;
        throw err;
      }
    },
    async delete(projectId) {
      await trx.deleteFrom('projects').where('id', '=', projectId).execute();
    },
  };
}

/** Project persistence over `database` (any database type holding the core tables and projects). */
export function createProjectStore<DB extends ProjectDatabase>(database: Kysely<DB>): ProjectStore {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<ProjectDatabase>;
  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(projectOperations(trx))),

    async list(workspaceId, params) {
      const result = await paginate(
        projects(db).where('projects.workspace_id', '=', workspaceId),
        {
          sorts: { created: { column: 'projects.created_at', direction: 'asc' } },
          idColumn: 'projects.id',
        },
        params,
      );
      return { ...result, data: result.data.map(toRecord) };
    },

    async findById(projectId) {
      const row = await projects(db).where('projects.id', '=', projectId).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async deleteForWorkspace(workspaceId) {
      const deleted = await db
        .deleteFrom('projects')
        .where('workspace_id', '=', workspaceId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('workspaces')
              .select('workspaces.id')
              .where('workspaces.id', '=', workspaceId)
              .where('workspaces.deleted_at', 'is not', null),
          ),
        )
        .executeTakeFirst();
      return Number(deleted.numDeletedRows);
    },
  };
}
