/**
 * Table types of e-mail sign-in links (B014, migration 20260102000500_login_tokens.sql). Written
 * by the magic-link store (apps/api/src/modules/auth/magic-link); only hashes of the token and of
 * the browser nonce are stored.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

export interface LoginTokensTable {
  /** sha256 of the token in the link, hex. */
  token_hash: ColumnType<string, string, never>;
  /** sha256 of the requesting browser's nonce cookie, hex. */
  nonce_hash: ColumnType<string, string, never>;
  /** The normalised address the link was sent to. */
  email: ColumnType<string, string, never>;
  /** Where the browser goes after signing in (already checked against the allow-list). */
  return_to: ColumnType<string, string, never>;
  created_at: CreatedAt;
  expires_at: ColumnType<Date, Date, never>;
  /** Set once, when the link is used (or given up on). */
  used_at: ColumnType<Date | null, never, Date>;
}

/** The login_tokens table. */
export interface LoginTokensDatabase {
  login_tokens: LoginTokensTable;
}

/** What the magic-link store reads and writes: the core tables and login_tokens. */
export type MagicLinkDatabase = CoreDatabase & LoginTokensDatabase;
