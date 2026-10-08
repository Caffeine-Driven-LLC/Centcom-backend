/**
 * Table types of API keys (B019, migration 20260102001100_api_keys.sql). Written by the API-key
 * store (apps/api/src/modules/apikeys/repo.ts); only the peppered hash of a key and its
 * 12-character prefix are stored.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, NullableTimestamp } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** `cen_live_…` or `cen_test_…`. */
export type ApiKeyMode = 'live' | 'test';

export interface ApiKeysTable {
  /** `key_` id. */
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  created_by: Fixed<string>;
  /** 1-60 characters. */
  name: Fixed<string>;
  mode: Fixed<ApiKeyMode>;
  /** sha256(pepper ‖ key), lower-case hex. */
  key_hash: Fixed<string>;
  /** The key's first 12 characters. */
  prefix: Fixed<string>;
  /** Space-separated scopes. */
  scope: Fixed<string>;
  created_at: CreatedAt;
  last_used_at: NullableTimestamp;
  expires_at: ColumnType<Date | null, Date | null | undefined, never>;
  revoked_at: NullableTimestamp;
}

/** The api_keys table. */
export interface ApiKeysDatabase {
  api_keys: ApiKeysTable;
}

/** What the API-key store reads and writes: the core tables and api_keys. */
export type ApiKeyDatabase = CoreDatabase & ApiKeysDatabase;
