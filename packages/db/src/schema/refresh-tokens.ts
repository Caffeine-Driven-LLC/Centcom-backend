/**
 * Table types of the refresh-token schema (B017, migration 20260102000000_refresh_tokens.sql).
 * Rows are written by the token service (apps/api/src/modules/auth/tokens); nothing but the
 * token's SHA-256 is stored.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt, NullableTimestamp } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;
/** A nullable column written once, at insert. */
type FixedNullable<T> = ColumnType<T | null, T | null | undefined, never>;

/** The public clients of CT-AUTH. */
export type ClientId = 'centcom-cli' | 'centcom-web' | 'centcom-tui';

export interface RefreshTokensTable {
  /** SHA-256 of the token, lower-case hex. */
  token_hash: Fixed<string>;
  /** 128 random bits, hex; shared by every rotation of one sign-in. */
  family_id: Fixed<string>;
  /** The token this one replaced; null for the first of a family. */
  parent_hash: FixedNullable<string>;
  user_id: Fixed<string>;
  device_id: FixedNullable<string>;
  client_id: Fixed<ClientId>;
  /** Space-separated scopes granted to the family. */
  scope: Fixed<string>;
  /** The access token's `wsp` claim. */
  workspace_id: FixedNullable<string>;
  created_at: CreatedAt;
  /** When the token was rotated; presenting it after that is reuse. */
  used_at: NullableTimestamp;
  /** 30 days after the rotation that issued it, never past `absolute_expires_at`. */
  expires_at: ColumnType<Date, Date | string, never>;
  /** 180 days after the family's first token. */
  absolute_expires_at: ColumnType<Date, Date | string, never>;
  revoked_at: NullableTimestamp;
  /** `staff` when staff revoked the token (B087, migration 20260102002900): its use is `token_revoked`. */
  revoked_reason: ColumnType<'staff' | null, 'staff' | null | undefined, 'staff' | null>;
}

/** The refresh-token table. */
export interface RefreshTokensDatabase {
  refresh_tokens: RefreshTokensTable;
}

/** What the token service reads and writes: the core tables and refresh tokens. */
export type TokenDatabase = CoreDatabase & RefreshTokensDatabase;
