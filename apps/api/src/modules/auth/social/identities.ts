/**
 * Identities (B015): which provider account belongs to which user. Only `(provider, subject)`
 * and the user id are stored. Linking is first-come: the table's primary key makes a second link
 * of one account fail, and the caller reads the winner.
 *
 * Owns: the SQL of identities. Must not: store anything else from the provider.
 */
import type { IdentityProvider, SocialDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';

/** Reads and writes of identities. */
export interface IdentityRepo {
  /** The user an account signs in as, or null for an account never seen. */
  findUserId(provider: IdentityProvider, subject: string): Promise<string | null>;
  /** Links an account to a user; false when the account was linked already (to anyone). */
  link(provider: IdentityProvider, subject: string, userId: string): Promise<boolean>;
}

/** True for the unique violation of an account linked twice. */
export function isIdentityTaken(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === 'identities_pkey';
}

/** A repository over `db` (which may be a transaction). */
export function createIdentityRepo(db: Kysely<SocialDatabase>): IdentityRepo {
  return {
    async findUserId(provider, subject) {
      const row = await db
        .selectFrom('identities')
        .select('user_id')
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.user_id ?? null;
    },
    async link(provider, subject, userId) {
      try {
        await db.insertInto('identities').values({ provider, subject, user_id: userId }).execute();
        return true;
      } catch (err) {
        if (isIdentityTaken(err)) return false;
        throw err;
      }
    },
  };
}
