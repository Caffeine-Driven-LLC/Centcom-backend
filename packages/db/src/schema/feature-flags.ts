/**
 * Table types of feature flags (B083, migration 20260102002500_feature_flags.sql). Written and read
 * by the API's flags module (`modules/flags/repository.ts`).
 */
import type { ColumnType, Generated } from 'kysely';

/** A flag's value type. */
export type FlagType = 'bool' | 'string' | 'number' | 'json';

export interface FeatureFlagsTable {
  /** `[a-z0-9_.-]{1,64}`. */
  key: ColumnType<string, string, never>;
  type: FlagType;
  /** JSON of `type`: written as JSON text, read as a value. */
  value: ColumnType<unknown, string, string>;
  default_value: ColumnType<unknown, string, string>;
  public: boolean;
  server_only: boolean;
  kill: boolean;
  /** A JSON array of rules: written as JSON text, read as an array. */
  rules: ColumnType<unknown, string, string>;
  /** The `usr_` or `key_` id of the last change. */
  updated_by: string;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface FeatureFlagsMetaTable {
  id: Generated<boolean>;
  /** The global revision: a bigint, read as text by `pg`. */
  rev: ColumnType<string, never, number | string>;
}

/** The flag tables. */
export interface FlagDatabase {
  feature_flags: FeatureFlagsTable;
  feature_flags_meta: FeatureFlagsMetaTable;
}
