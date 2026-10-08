/**
 * Table types of workspace settings (B034, migration 20260102001300_workspace_settings.sql): one
 * row per workspace that changed its defaults. Written by the settings store
 * (`repos/workspace-settings.ts`); enums, a flag and a count only.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, UpdatedAt } from './core.js';

/** CT-WS-QUEUE rule 3 / `control.policy`'s auto-approve levels. */
export type AutoApprove = 'ask' | 'trusted' | 'everyone';

export interface WorkspaceSettingsTable {
  workspace_id: ColumnType<string, string, never>;
  auto_approve: ColumnType<AutoApprove, AutoApprove | undefined, AutoApprove>;
  share_history: ColumnType<boolean, boolean | undefined, boolean>;
  /** Days of history to keep, below the plan's `history_days`; null: the plan's. */
  retention_days: ColumnType<number | null, number | null | undefined, number | null>;
  /** Moves on with every change: the settings' ETag. */
  version: ColumnType<number, number | undefined, number>;
  updated_at: UpdatedAt;
}

/** The workspace_settings table. */
export interface WorkspaceSettingsDatabase {
  workspace_settings: WorkspaceSettingsTable;
}

/** What the settings store reads and writes: the core tables and the settings. */
export type WorkspaceSettingsDb = CoreDatabase & WorkspaceSettingsDatabase;
