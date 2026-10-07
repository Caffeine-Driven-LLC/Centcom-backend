/**
 * Login token store (B014): where e-mail sign-in links are kept, as hashes. `insert` records a
 * link; `consume` uses one atomically (unused, unexpired and issued to this browser, in one
 * statement, so two concurrent uses cannot both win); `invalidate` gives one up (its mail never
 * left).
 *
 * Owns: the login_tokens rows. Must not: keep a token or a nonce in clear, or let a row be used
 * twice.
 */
import type { MagicLinkDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';

/** A link to remember. */
export interface NewLoginToken {
  /** sha256 of the token, hex. */
  tokenHash: string;
  /** sha256 of the requesting browser's nonce, hex. */
  nonceHash: string;
  /** The normalised address. */
  email: string;
  /** Where to go after signing in (already resolved against the allow-list). */
  returnTo: string;
  expiresAt: Date;
}

/** Where sign-in links are kept. */
export interface LoginTokenStore {
  insert(token: NewLoginToken): Promise<void>;
  /**
   * Uses the link with `tokenHash`, issued to the browser with `nonceHash`, unused and not expired
   * at `now`, and returns its address and return_to; null when there is no such link.
   */
  consume(
    tokenHash: string,
    nonceHash: string,
    now: Date,
  ): Promise<{ email: string; returnTo: string } | null>;
  /** Marks the link used without signing anyone in (its mail could not be sent). */
  invalidate(tokenHash: string, now: Date): Promise<void>;
}

/** The store on Postgres (table `login_tokens`, migration 20260102000500). */
export function createLoginTokenStore(db: Kysely<MagicLinkDatabase>): LoginTokenStore {
  return {
    async insert(token) {
      await db
        .insertInto('login_tokens')
        .values({
          token_hash: token.tokenHash,
          nonce_hash: token.nonceHash,
          email: token.email,
          return_to: token.returnTo,
          expires_at: token.expiresAt,
        })
        .execute();
    },

    async consume(tokenHash, nonceHash, now) {
      const row = await db
        .updateTable('login_tokens')
        .set({ used_at: now })
        .where('token_hash', '=', tokenHash)
        .where('nonce_hash', '=', nonceHash)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .returning(['email', 'return_to'])
        .executeTakeFirst();
      return row === undefined ? null : { email: row.email, returnTo: row.return_to };
    },

    async invalidate(tokenHash, now) {
      await db
        .updateTable('login_tokens')
        .set({ used_at: now })
        .where('token_hash', '=', tokenHash)
        .where('used_at', 'is', null)
        .execute();
    },
  };
}
