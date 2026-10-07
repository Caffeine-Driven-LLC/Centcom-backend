/**
 * Table types of the social-login schema (B015, migration 20260102000400_identities.sql).
 * Written by the social login service (apps/api/src/modules/auth/social); nothing but the
 * provider and its account id is stored.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** External sign-in providers. */
export type IdentityProvider = 'github' | 'google';

export interface IdentitiesTable {
  provider: ColumnType<IdentityProvider, IdentityProvider, never>;
  /** The provider's stable account id (GitHub's numeric id, Google's `sub`). */
  subject: ColumnType<string, string, never>;
  user_id: ColumnType<string, string, never>;
  created_at: CreatedAt;
}

/** The identities table. */
export interface IdentitiesDatabase {
  identities: IdentitiesTable;
}

/** What the social login service reads and writes: the core tables and identities. */
export type SocialDatabase = CoreDatabase & IdentitiesDatabase;
