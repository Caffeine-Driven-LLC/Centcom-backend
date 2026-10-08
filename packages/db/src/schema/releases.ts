/**
 * Table types of release manifests (B084, migration 20260102002600_releases.sql). Written by the
 * release publisher (`pnpm release:publish`) and read by the API's releases module.
 */
import type { ColumnType } from 'kysely';

/** A release channel. */
export type ReleaseChannel = 'stable' | 'beta' | 'nightly';

export interface ReleasesTable {
  channel: ColumnType<ReleaseChannel, ReleaseChannel, never>;
  version: ColumnType<string, string, never>;
  released_at: ColumnType<Date, Date, never>;
  min_supported: ColumnType<string, string, never>;
  /** The manifest exactly as published. */
  manifest: ColumnType<string, string, never>;
  manifest_sha256: ColumnType<string, string, never>;
  status: ColumnType<
    'active' | 'superseded',
    'active' | 'superseded' | undefined,
    'active' | 'superseded'
  >;
  yanked_at: ColumnType<Date | null, never, Date | null>;
  yank_reason: ColumnType<string | null, never, string | null>;
  /** `usr_`/`key_` id, or the publishing tool's name. */
  published_by: ColumnType<string, string, never>;
  published_at: ColumnType<Date, Date | undefined, never>;
}

export interface ReleaseArtifactsTable {
  channel: ColumnType<ReleaseChannel, ReleaseChannel, never>;
  version: ColumnType<string, string, never>;
  platform: ColumnType<'linux' | 'darwin' | 'win32', string, never>;
  arch: ColumnType<'x64' | 'arm64', string, never>;
  kind: ColumnType<string, string | undefined, never>;
  url: ColumnType<string, string, never>;
  sha256: ColumnType<string, string, never>;
  /** A bigint, read as text by `pg`. */
  size: ColumnType<string, number, never>;
  sig: ColumnType<string, string, never>;
  sig_kid: ColumnType<string | null, string | null, never>;
}

/** The release tables. */
export interface ReleaseDatabase {
  releases: ReleasesTable;
  release_artifacts: ReleaseArtifactsTable;
}
