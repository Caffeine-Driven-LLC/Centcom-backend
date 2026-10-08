/**
 * Workspace settings (B034): the Postgres side of `/v1/workspaces/{id}/settings` and of the
 * `settings` field of a workspace PATCH.
 *
 * A change runs in one transaction that first locks the live workspace's row (the same lock B027's
 * PATCH takes), so settings changes, renames and deletes of one workspace take turns: of two
 * changes made against one version, the second sees the first's. The row is written with an
 * upsert, so a workspace's first change creates it. Inside B027's PATCH the operations run in its
 * transaction (`within`), whose lock is already held.
 *
 * Owns: the SQL of settings. Must not: store anything but the three policies and the version.
 */
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { AuditDb } from '@centcom/core';
import type { AutoApprove, WorkspaceSettingsDb } from '../schema/workspace-settings.js';
import { withTransaction } from '../tx.js';

/** A workspace's stored settings. */
export interface WorkspaceSettingsRecord {
  autoApprove: AutoApprove;
  shareHistory: boolean;
  /** Days of history to keep; null: the plan's `history_days`. */
  retentionDays: number | null;
  /** 1 for the first stored change, then one more per change. */
  version: number;
}

/** The policies a change writes. */
export type WorkspaceSettingsValues = Omit<WorkspaceSettingsRecord, 'version'>;

/** Settings operations in one transaction. */
export interface WorkspaceSettingsTx {
  /** The transaction itself: audit events written through it commit with the change. */
  readonly trx: AuditDb;
  /** Locks the live workspace's row until commit; false when there is no live workspace. */
  lockWorkspace(workspaceId: string): Promise<boolean>;
  /** The stored settings, or null when the workspace has none (the defaults apply). */
  read(workspaceId: string): Promise<WorkspaceSettingsRecord | null>;
  /** Stores `values` as `version`, creating the row or replacing it. */
  write(workspaceId: string, values: WorkspaceSettingsValues, version: number): Promise<void>;
}

/** Settings persistence. */
export interface WorkspaceSettingsStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: WorkspaceSettingsTx) => Promise<T>): Promise<T>;
  /** The operations inside a transaction someone else opened (B027's PATCH `tx.trx`). */
  within(trx: AuditDb): WorkspaceSettingsTx;
  /** The stored settings of a workspace, or null. */
  get(workspaceId: string): Promise<WorkspaceSettingsRecord | null>;
  /** Deletes the settings of a soft-deleted workspace (B027's purge hook); returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

type Row = {
  auto_approve: AutoApprove;
  share_history: boolean;
  retention_days: number | null;
  version: number;
};

const record = (row: Row): WorkspaceSettingsRecord => ({
  autoApprove: row.auto_approve,
  shareHistory: row.share_history,
  retentionDays: row.retention_days,
  version: row.version,
});

/** The store on Postgres (table `workspace_settings`, migration 20260102001300). */
export function createWorkspaceSettingsStore<DB extends WorkspaceSettingsDb>(
  database: Kysely<DB>,
): WorkspaceSettingsStore {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<WorkspaceSettingsDb>;
  const columns = ['auto_approve', 'share_history', 'retention_days', 'version'] as const;

  /** The operations on `trx`: queries are compiled here and executed in that transaction. */
  const within = (trx: AuditDb): WorkspaceSettingsTx => {
    const run = <R>(query: CompiledQuery<R>): Promise<R[]> =>
      trx.executeQuery(query).then((result) => result.rows);
    return {
      trx,
      async lockWorkspace(workspaceId) {
        const rows = await run(
          db
            .selectFrom('workspaces')
            .select('id')
            .where('id', '=', workspaceId)
            .where('deleted_at', 'is', null)
            .forUpdate()
            .compile(),
        );
        return rows.length === 1;
      },
      async read(workspaceId) {
        const rows = await run(
          db
            .selectFrom('workspace_settings')
            .select(columns)
            .where('workspace_id', '=', workspaceId)
            .compile(),
        );
        return rows[0] === undefined ? null : record(rows[0]);
      },
      async write(workspaceId, values, version) {
        const row = {
          auto_approve: values.autoApprove,
          share_history: values.shareHistory,
          retention_days: values.retentionDays,
          version,
        };
        await run(
          db
            .insertInto('workspace_settings')
            .values({ workspace_id: workspaceId, ...row })
            .onConflict((oc) =>
              oc.column('workspace_id').doUpdateSet({ ...row, updated_at: sql`now()` }),
            )
            .compile(),
        );
      },
    };
  };

  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(within(trx))),
    within,
    async get(workspaceId) {
      const row = await db
        .selectFrom('workspace_settings')
        .select(columns)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row === undefined ? null : record(row);
    },
    async deleteForWorkspace(workspaceId) {
      const result = await db
        .deleteFrom('workspace_settings')
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
      return Number(result.numDeletedRows);
    },
  };
}
