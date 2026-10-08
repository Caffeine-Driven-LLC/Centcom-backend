/**
 * Table types of workspace projects (B035, migration 20260102001000_projects.sql). `repo_ref` is
 * an opaque identifier chosen by the client, never a local path, URL with credentials or token.
 */
import type { ColumnType, Generated } from 'kysely';
import type { CoreDatabase, CreatedAt, FixedId, UpdatedAt } from './core.js';

export interface ProjectsTable {
  /** `prj_` id. */
  id: FixedId;
  workspace_id: FixedId;
  /** 1-60 characters; unique per workspace ignoring case. */
  name: string;
  /** Opaque, 1-128 characters, or null. */
  repo_ref: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: FixedId;
  /** The ETag; incremented on every change. */
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The projects table. */
export interface ProjectsDatabase {
  projects: ProjectsTable;
}

/** What the project store reads and writes: the core tables and projects. */
export type ProjectDatabase = CoreDatabase & ProjectsDatabase;
