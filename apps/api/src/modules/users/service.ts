/**
 * User service (B013): the domain rules over the user repository. `getOrCreateByEmail` is the
 * first sign-in of every login method: it normalises the address, returns the existing user, or
 * creates the user with a personal one-person workspace and its `owner` membership in one
 * transaction. Concurrent first sign-ins for one address end with one user: the losers' inserts
 * hit the e-mail's unique constraint, roll back whole, and read the winner's user.
 *
 * Owns: user creation and profile updates. Must not: log e-mail addresses (only `usr_` ids), return
 * users to anything but server code (authorisation is B021's), or create a user without its
 * personal workspace.
 */
import type { IdPrefix } from '@centcom/contracts';
import {
  createUserRepo,
  isEmailTaken,
  withTransaction,
  type CoreDatabase,
  type ProfilePatch,
  type User,
  type UserRepo,
} from '@centcom/db';
import type { Kysely } from 'kysely';
import { defaultDisplayName, validateEmail, validateProfilePatch } from './validation.js';

/** What the service needs. */
export interface UserServiceDeps {
  db: Kysely<CoreDatabase>;
  /** Default: a repository over `db`. */
  repo?: UserRepo;
  /** CT-IDS id generator (`newId` from @centcom/contracts). */
  newId: (prefix: IdPrefix) => string;
  /** The time, for rows the service stamps itself. */
  now: () => Date;
}

/** The outcome of a sign-in. */
export interface SignInResult {
  user: User;
  /** True when this call created the user (and the personal workspace). */
  created: boolean;
}

/** The slug of a personal workspace: `p-` and the workspace id's ULID, lower-cased (unique, 28 characters). */
export const personalSlug = (workspaceId: string): string =>
  `p-${workspaceId.slice(4).toLowerCase()}`;

/** Users: sign-in bootstrap and profile updates. */
export class UserService {
  private readonly db: Kysely<CoreDatabase>;
  private readonly repo: UserRepo;
  private readonly newId: (prefix: IdPrefix) => string;
  private readonly now: () => Date;

  constructor(deps: UserServiceDeps) {
    this.db = deps.db;
    this.repo = deps.repo ?? createUserRepo(deps.db);
    this.newId = deps.newId;
    this.now = deps.now;
  }

  /**
   * The user with this e-mail address, created on first sign-in together with a personal
   * workspace named after them and their `owner` membership. `hints.name` is the display name a
   * login method offered; without a usable one it comes from the address's local part. An invalid
   * address is a validation AppError, before any query.
   */
  async getOrCreateByEmail(email: string, hints: { name?: string } = {}): Promise<SignInResult> {
    const address = validateEmail(email);
    const existing = await this.repo.findByEmail(address);
    if (existing !== null) return { user: existing, created: false };
    try {
      const user = await withTransaction(this.db, (trx) =>
        this.createWithWorkspace(trx, address, hints.name),
      );
      return { user, created: true };
    } catch (err) {
      if (!isEmailTaken(err)) throw err;
      // Another sign-in for this address won the race; its user (and workspace) stand.
      const winner = await this.repo.findByEmail(address);
      if (winner === null) throw err;
      return { user: winner, created: false };
    }
  }

  /** Checks and applies a profile patch; a validation AppError names every bad field. */
  async updateProfile(id: string, patch: ProfilePatch): Promise<User> {
    return this.repo.updateProfile(id, validateProfilePatch(patch));
  }

  private async createWithWorkspace(
    trx: Kysely<CoreDatabase>,
    email: string,
    hint: string | undefined,
  ): Promise<User> {
    const now = this.now();
    const user = await createUserRepo(trx).create({
      id: this.newId('usr'),
      email,
      display_name: defaultDisplayName(email, hint),
    });
    const workspaceId = this.newId('wsp');
    await trx
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        // A display name (1-40) is always a valid workspace name (1-60).
        name: user.display_name,
        slug: personalSlug(workspaceId),
        created_by: user.id,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('memberships')
      .values({
        id: this.newId('mem'),
        workspace_id: workspaceId,
        user_id: user.id,
        role: 'owner',
        created_at: now,
      })
      .execute();
    return user;
  }
}
