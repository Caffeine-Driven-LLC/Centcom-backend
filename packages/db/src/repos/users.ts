/**
 * User repository (B013): every read and write of the `users` table (B008) goes through here.
 * Rows come back as `User`, built from an explicit column list, so a column a later migration adds
 * never leaks to callers. E-mail addresses are NFC-normalised and lower-cased before every lookup
 * and write (CT-IDS); the column is citext besides, so no comparison is ever case-sensitive.
 *
 * Owns: the SQL of users. Must not: validate profile fields (the users service does, with typed
 * errors), log e-mail addresses, or open its own transaction (pass the transaction in instead).
 */
import { normaliseEmail } from '@centcom/contracts';
import { notFound, validationFailed } from '@centcom/core';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { CoreDatabase, UsersTable, UserStatus } from '../schema/core.js';

/** A user as the application sees it: exactly these fields. */
export type User = Selectable<UsersTable>;

/** The columns of `User`, in table order: the only ones the repository ever selects. */
export const USER_COLUMNS = [
  'id',
  'email',
  'display_name',
  'locale',
  'avatar_slot',
  'telemetry_opt_in',
  'status',
  'deletion_requested_at',
  'created_at',
  'updated_at',
] as const satisfies readonly (keyof User)[];

/** What creating a user needs; the database fills the rest (locale `en`, status `active`, times). */
export interface NewUser {
  id: string;
  email: string;
  display_name: string;
  locale?: string;
  avatar_slot?: string | null;
  telemetry_opt_in?: boolean;
}

/** The profile fields a user may change. */
export interface ProfilePatch {
  display_name?: string;
  locale?: string;
  /** The avatar slot identifier (CT-API-ACCOUNTS `avatar`), or null to clear it. */
  avatar_slot?: string | null;
  telemetry_opt_in?: boolean;
}

/** Reads and writes of users. */
export interface UserRepo {
  /** Inserts a user; a taken e-mail fails with the database's unique violation (23505, `users_email_key`). */
  create(user: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** Case-insensitive; any status (callers decide what a pending or deleted account means). */
  findByEmail(email: string): Promise<User | null>;
  /** Applies `patch` and bumps `updated_at`; a 404 AppError when there is no such user. */
  updateProfile(id: string, patch: ProfilePatch): Promise<User>;
  /** Status `pending_deletion` with the request time; a 404 AppError when there is no such user. */
  markDeletionRequested(id: string, at: Date): Promise<void>;
  /** Status `deleted`; a 404 AppError when there is no such user. */
  markDeleted(id: string): Promise<void>;
  /** The users of `ids` that exist, in the order of `ids` (repeats once). */
  listByIds(ids: readonly string[]): Promise<User[]>;
}

/** The Postgres constraint that keeps e-mail addresses unique. */
export const USERS_EMAIL_KEY = 'users_email_key';

/** True for the unique violation of a taken e-mail address. */
export function isEmailTaken(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === USERS_EMAIL_KEY;
}

/** NFC, lower case (CT-IDS); null for something that cannot be an address. */
function emailKey(email: string): string | null {
  const result = normaliseEmail(email);
  return result.ok ? result.value : null;
}

/** A repository over `db`, which may be a transaction. */
export function createUserRepo(db: Kysely<CoreDatabase>): UserRepo {
  const select = () => db.selectFrom('users').select(USER_COLUMNS);

  const setStatus = async (id: string, status: UserStatus, at?: Date): Promise<void> => {
    const result = await db
      .updateTable('users')
      .set({
        status,
        ...(at === undefined ? {} : { deletion_requested_at: at }),
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw notFound('There is no such user.');
  };

  return {
    async create(user) {
      const email = emailKey(user.email);
      if (email === null) {
        throw validationFailed([
          { pointer: '/email', code: 'invalid_format', detail: 'is not an e-mail address' },
        ]);
      }
      return db
        .insertInto('users')
        .values({ ...user, email })
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
    },

    async findById(id) {
      return (await select().where('id', '=', id).executeTakeFirst()) ?? null;
    },

    async findByEmail(email) {
      const key = emailKey(email);
      if (key === null) return null;
      return (await select().where('email', '=', key).executeTakeFirst()) ?? null;
    },

    async updateProfile(id, patch) {
      const user = await db
        .updateTable('users')
        .set({ ...patch, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(USER_COLUMNS)
        .executeTakeFirst();
      if (user === undefined) throw notFound('There is no such user.');
      return user;
    },

    markDeletionRequested: (id, at) => setStatus(id, 'pending_deletion', at),

    markDeleted: (id) => setStatus(id, 'deleted'),

    async listByIds(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const rows = await select().where('id', 'in', unique).execute();
      const byId = new Map(rows.map((row) => [row.id, row]));
      return unique.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      });
    },
  };
}
