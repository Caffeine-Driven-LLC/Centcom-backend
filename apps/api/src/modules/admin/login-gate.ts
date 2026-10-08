/**
 * The sign-in gate (B087) for B017's token service: a user whose sign-in staff disabled
 * (`users.login_disabled_at`) gets no tokens, from any grant or a refresh: 403 `access_denied`.
 * Wire it as `new TokenService({ ..., signInGate: createLoginGate(db) })`.
 *
 * Owns: the check. Must not: say why beyond "disabled".
 */
import { AppError } from '@centcom/core';
import type { AdminDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import type { SignInGate } from '../auth/tokens/service.js';

/** The refusal of a disabled user. */
export const loginDisabled = (): AppError =>
  new AppError('access_denied', { detail: 'Sign-in is disabled for this account.' });

/** A gate reading `users.login_disabled_at`. */
export function createLoginGate(db: Kysely<AdminDatabase>): SignInGate {
  return {
    async assertCanSignIn(userId) {
      const row = await db
        .selectFrom('users')
        .select('login_disabled_at')
        .where('id', '=', userId)
        .executeTakeFirst();
      if (row !== undefined && row.login_disabled_at !== null) throw loginDisabled();
    },
  };
}
