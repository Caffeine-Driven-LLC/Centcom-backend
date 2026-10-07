/**
 * The account service behind `/v1/me` (B022, CT-API-ACCOUNTS). `get` returns the caller's user,
 * plan, active workspace and entitlement revision, and the user's version for the ETag. `update`
 * applies a profile patch as one compare-and-set statement: with `If-Match`, only when the row is
 * still at that version, so of two writers holding the same ETag exactly one wins. Each successful
 * update is audited.
 *
 * The active workspace is the token's `wsp` claim while the user is still a member of that (live)
 * workspace, else the user's personal workspace: the first live workspace they created and own,
 * which B013 makes with the account.
 *
 * Owns: reading and updating one's own account. Must not: change email, id or status, return
 * another user's data, or trust the `wsp` claim without checking membership.
 */
import type { Api } from '@centcom/contracts';
import { unavailable, type Logger, type Metrics } from '@centcom/core';
import {
  isConnectionError,
  USER_COLUMNS,
  type CoreDatabase,
  type ProfilePatch,
  type User,
} from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { freePlanLookup, type EntitlementsLookup } from './entitlements-lookup.js';
import { ifMatchAccepts, type IfMatch, type UserVersion } from './etag.js';

/** CT-API-ACCOUNTS: account deletion has a 30-day grace period. */
export const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** A user and the version of its row. */
export interface VersionedUser {
  user: User;
  version: UserVersion;
}

/** The outcome of a compare-and-set update. */
export type UpdateOutcome =
  { kind: 'updated'; user: VersionedUser } | { kind: 'stale' } | { kind: 'missing' };

/** Where accounts live: `createAccountStore` (Postgres) in the API, a fake in tests. */
export interface AccountStore {
  /** The user and its version; null when there is none or it is deleted. */
  find(userId: string): Promise<VersionedUser | null>;
  /** Applies `patch` (and moves the version) only when the row is at one of `versions` (any, when absent). */
  update(
    userId: string,
    patch: ProfilePatch,
    versions?: readonly UserVersion[],
  ): Promise<UpdateOutcome>;
  /** True when the user is a member of the workspace and it is not deleted. */
  isMember(userId: string, workspaceId: string): Promise<boolean>;
  /** The user's personal workspace (the first live workspace they created and own), or null. */
  personalWorkspace(userId: string): Promise<string | null>;
}

/** The row's version: microseconds of `updated_at` (exact: Postgres stores microseconds). */
const versionOf = sql<string>`(extract(epoch from updated_at) * 1000000)::bigint::text`;

/** Accounts in Postgres. */
export function createAccountStore(db: Kysely<CoreDatabase>): AccountStore {
  const toVersioned = (row: User & { version: string }): VersionedUser => {
    const { version, ...user } = row;
    return { user, version };
  };
  return {
    async find(userId) {
      const row = await db
        .selectFrom('users')
        .select([...USER_COLUMNS, versionOf.as('version')])
        .where('id', '=', userId)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      return row === undefined ? null : toVersioned(row);
    },
    async update(userId, patch, versions) {
      if (versions !== undefined && versions.length === 0)
        return (await this.find(userId)) === null ? { kind: 'missing' } : { kind: 'stale' };
      let query = db
        .updateTable('users')
        .set({ ...patch, updated_at: sql<Date>`now()` })
        .where('id', '=', userId)
        .where('status', '<>', 'deleted');
      // One statement compares and sets: a concurrent writer holding the same version finds the row moved on.
      if (versions !== undefined) query = query.where(versionOf, 'in', [...versions]);
      const row = await query
        .returning([...USER_COLUMNS, versionOf.as('version')])
        .executeTakeFirst();
      if (row !== undefined) return { kind: 'updated', user: toVersioned(row) };
      return (await this.find(userId)) === null ? { kind: 'missing' } : { kind: 'stale' };
    },
    async isMember(userId, workspaceId) {
      const row = await db
        .selectFrom('memberships')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select('memberships.id')
        .where('memberships.user_id', '=', userId)
        .where('memberships.workspace_id', '=', workspaceId)
        .where('workspaces.deleted_at', 'is', null)
        .executeTakeFirst();
      return row !== undefined;
    },
    async personalWorkspace(userId) {
      const row = await db
        .selectFrom('workspaces')
        .innerJoin('memberships', 'memberships.workspace_id', 'workspaces.id')
        .select('workspaces.id')
        .where('workspaces.created_by', '=', userId)
        .where('workspaces.deleted_at', 'is', null)
        .where('memberships.user_id', '=', userId)
        .where('memberships.role', '=', 'owner')
        .orderBy('workspaces.created_at')
        .orderBy('workspaces.id')
        .executeTakeFirst();
      return row?.id ?? null;
    },
  };
}

/** The caller of `/v1/me`, as the authentication plugin (B017) knows it. */
export interface MeCaller {
  userId: string;
  /** The token's `wsp` claim, a hint only. */
  workspaceId?: string;
}

/** The audit event of a profile change: which fields, never their values. */
export interface AccountUpdatedEvent {
  action: 'account.updated';
  userId: string;
  fields: string[];
  /** ISO 8601. */
  at: string;
}

/** Where account changes are recorded (B036's audit emitter). */
export interface AccountAuditSink {
  record(event: AccountUpdatedEvent): Promise<void>;
}

/** What the service needs. */
export interface MeServiceDeps {
  store: AccountStore;
  audit: AccountAuditSink;
  /** Default: everyone on the free plan. Wrap a real one in `withFreePlanFallback`. */
  entitlements?: EntitlementsLookup;
  logger?: Logger;
  metrics?: Metrics;
  now?: () => number;
}

/** The `/v1/me` resource and the version its ETag names. */
export interface MeView {
  me: Api.Me;
  version: UserVersion;
}

/** The PATCH answer and the new version. */
export interface UserView {
  user: Api.User;
  version: UserVersion;
}

/** The contract's `User` (CT-API-ACCOUNTS): `avatar` and `telemetry` by their API names. */
export function toApiUser(user: User): Api.User {
  const scheduled =
    user.status === 'pending_deletion' && user.deletion_requested_at !== null
      ? new Date(user.deletion_requested_at.getTime() + DELETION_GRACE_MS).toISOString()
      : null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    locale: user.locale,
    avatar: user.avatar_slot,
    telemetry: user.telemetry_opt_in,
    created_at: user.created_at.toISOString(),
    deletion_scheduled_for: scheduled,
  };
}

/** A DB failure that is the database's fault: 503 with `retry_after_s`; the cause keeps no details. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(1, 'The account service is busy. Try again shortly.', {
      cause: new Error('database unavailable'),
    });
  }
  throw err;
}

const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    return databaseFailure(err);
  }
};

/** `/v1/me`. */
export class MeService {
  private readonly store: AccountStore;
  private readonly audit: AccountAuditSink;
  private readonly entitlements: EntitlementsLookup;
  private readonly logger: Logger | undefined;
  private readonly metrics: Metrics | undefined;
  private readonly now: () => number;

  constructor(deps: MeServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.entitlements = deps.entitlements ?? freePlanLookup;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  /** The caller's account; null when the user is gone (404). */
  async get(caller: MeCaller): Promise<MeView | null> {
    const found = await guarded(() => this.store.find(caller.userId));
    if (found === null) return null;
    const activeWorkspace = await guarded(() => this.activeWorkspace(caller));
    const plan = await this.entitlements.forUser(caller.userId, activeWorkspace ?? undefined);
    return {
      me: {
        user: toApiUser(found.user),
        plan: plan.plan,
        active_workspace: activeWorkspace,
        ent: plan.rev,
      },
      version: found.version,
    };
  }

  /**
   * Applies a checked patch (B013's rules, see `parseMeUpdate`) under `If-Match`. Answers the new
   * user, `stale` (412) or `missing` (404). An empty patch changes nothing but still honours If-Match.
   */
  async update(
    caller: MeCaller,
    patch: ProfilePatch,
    ifMatch?: IfMatch,
  ): Promise<UserView | 'stale' | 'missing'> {
    const fields = Object.keys(patch);
    if (fields.length === 0) {
      const current = await guarded(() => this.store.find(caller.userId));
      if (current === null) return 'missing';
      if (!ifMatchAccepts(ifMatch, current.version)) return 'stale';
      return { user: toApiUser(current.user), version: current.version };
    }
    const versions = ifMatch === undefined || ifMatch.any ? undefined : ifMatch.versions;
    const outcome = await guarded(() => this.store.update(caller.userId, patch, versions));
    if (outcome.kind !== 'updated') return outcome.kind;
    try {
      await this.audit.record({
        action: 'account.updated',
        userId: caller.userId,
        fields: fields.sort(),
        at: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      // The change is made; a lost audit record is counted and logged, not turned into an error.
      this.metrics?.counter('account_audit_failures_total').inc();
      this.logger?.error({ err }, 'me.audit_failed');
    }
    return { user: toApiUser(outcome.user.user), version: outcome.user.version };
  }

  /** The `wsp` claim while the caller is still a member, else the personal workspace. */
  private async activeWorkspace(caller: MeCaller): Promise<string | null> {
    if (
      caller.workspaceId !== undefined &&
      (await this.store.isMember(caller.userId, caller.workspaceId))
    ) {
      return caller.workspaceId;
    }
    return this.store.personalWorkspace(caller.userId);
  }
}
