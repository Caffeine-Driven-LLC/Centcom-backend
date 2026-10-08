/**
 * The account purge (B026), run by the `account-purge` job at the end of the 30-day grace period.
 *
 * `purgeUser` is idempotent and resumable; each step can run again:
 *
 * 1. **Check.** No user row: `gone`. A user who is not pending deletion (restored, or
 *    `cancelDeletion` ran): `cancelled`. A deadline still in the future: `not_due`. A user who
 *    became the only owner of a workspace with other members during the grace period: `blocked`
 *    (nothing is deleted, `account_purge_blocked_total` counts it; a human decides).
 * 2. **Files.** The user's export files are deleted from the object store.
 * 3. **Personal data**, in one transaction that locks the user's row: the exports, notifications,
 *    notification preferences, push subscriptions, sign-in identities and grants, refresh tokens,
 *    the API keys they created, pending sign-in links to their e-mail address, and their
 *    memberships (except in workspaces where they are the only member). The user row is scrubbed:
 *    no e-mail of theirs, name, avatar or locale; status `deleted`, `deleted_at` set. Device names
 *    are scrubbed too.
 * 4. **Audit**, in that same transaction: every audit event naming the user as actor or target is
 *    rewritten to `usr_deleted` (`pseudonymise_audit_user`), never deleted (retention is B090's);
 *    an `account.purge` event without the user's id records it.
 * 5. **Workspaces** the user was the only member of are deleted the way their owner would
 *    (B027: hidden at once, then the `workspace-purge` job); a retry deletes them again.
 * 6. **Finish.** While those workspaces still exist the result is `waiting` (the job retries).
 *    Then the devices no session references are deleted, and the user row itself: `deleted`. When
 *    other people's records still point at the user (a workspace they created, a session they
 *    joined), the scrubbed row stays: `scrubbed`.
 *
 * A failing step throws; the job retries with backoff, and the steps already done are skipped.
 *
 * Owns: the purge. Must not: delete another user's data or a workspace that has other members,
 * delete audit events, or log anything but ids and counts.
 */
import { AppError, noopMetrics, type AuditEmitter, type Logger, type Metrics } from '@centcom/core';
import {
  withTransaction,
  type DeviceGrantsDatabase,
  type IdentitiesDatabase,
  type LoginTokensDatabase,
  type NotificationsDatabase,
  type PushSubscriptionsDatabase,
} from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ACCOUNT_ACTIONS, type AccountLifecycleAction } from './actions.js';
import type { WorkspaceService } from '../workspaces/service.js';
import type { ExportBlobStore } from './blob-store.js';
import { blockingWorkspaces, type LifecycleDb } from './store.js';

/** The tables the purge touches. */
export type PurgeDb = LifecycleDb &
  IdentitiesDatabase &
  DeviceGrantsDatabase &
  NotificationsDatabase &
  PushSubscriptionsDatabase &
  LoginTokensDatabase;

/** The constant audit rows carry instead of a purged user's id. */
export const DELETED_USER_ID = 'usr_deleted';
/** The system actor of `account.purge`. */
export const PURGE_ACTOR = 'account-purge';
/** The name a purged user's row keeps while it must stay. */
export const DELETED_USER_NAME = 'Deleted user';
/** The name a purged user's devices keep while sessions reference them. */
export const DELETED_DEVICE_NAME = 'Deleted device';

/** What a purge run did. */
export type PurgeOutcome =
  'deleted' | 'scrubbed' | 'waiting' | 'blocked' | 'cancelled' | 'not_due' | 'gone';

/** What the purge needs. */
export interface PurgeDeps {
  db: Kysely<PurgeDb>;
  blobs: Pick<ExportBlobStore, 'delete'>;
  /**
   * Deletes a workspace as its owner would; must resolve for one already deleted
   * (`workspaceDeleterFrom` over B027's `WorkspaceService`).
   */
  deleteWorkspace(workspaceId: string): Promise<void>;
  /** Writes `account.purge` (`ACCOUNT_LIFECYCLE_ACTIONS`). */
  emitter: Pick<AuditEmitter<AccountLifecycleAction>, 'emit'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** The address a scrubbed row keeps: unique, not deliverable (`.invalid`, RFC 2606). */
export const scrubbedEmail = (userId: string): string =>
  `deleted+${userId.toLowerCase()}@deleted.invalid`;

/** The live workspaces `userId` is the only member of. */
async function soleWorkspaces(db: Kysely<PurgeDb>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('memberships as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .select('m.workspace_id')
    .where('m.user_id', '=', userId)
    .where('w.deleted_at', 'is', null)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('memberships as o')
            .select('o.id')
            .whereRef('o.workspace_id', '=', 'm.workspace_id')
            .where('o.user_id', '<>', userId),
        ),
      ),
    )
    .orderBy('m.workspace_id')
    .execute();
  return rows.map((r) => r.workspace_id);
}

/** Writes `account.purge` in `trx`; the user's id is not in it (it was just pseudonymised). */
async function auditPurge(
  deps: PurgeDeps,
  trx: Transaction<PurgeDb>,
  outcome: 'scrubbed' | 'deleted',
): Promise<void> {
  await deps.emitter.emit(trx, {
    workspaceId: null,
    actor: { type: 'system', id: PURGE_ACTOR },
    action: ACCOUNT_ACTIONS.purge,
    outcome: 'success',
    meta: { outcome },
  });
}

/** Steps 2-4: removes the user's personal data. False when the user is no longer due. */
async function removePersonalData(deps: PurgeDeps, userId: string, now: Date): Promise<boolean> {
  const exportKeys = await deps.db
    .selectFrom('account_exports')
    .select('blob_key')
    .where('user_id', '=', userId)
    .where('blob_key', 'is not', null)
    .execute();
  for (const { blob_key: key } of exportKeys) if (key !== null) await deps.blobs.delete(key);

  const sole = await soleWorkspaces(deps.db, userId);
  return withTransaction(deps.db, async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['email', 'status', 'deletion_scheduled_at'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (
      user === undefined ||
      user.status !== 'pending_deletion' ||
      user.deletion_scheduled_at === null ||
      user.deletion_scheduled_at > now
    ) {
      return false;
    }
    await trx.deleteFrom('account_exports').where('user_id', '=', userId).execute();
    await trx.deleteFrom('notifications').where('user_id', '=', userId).execute();
    await trx.deleteFrom('notification_pref').where('user_id', '=', userId).execute();
    await trx.deleteFrom('push_subscriptions').where('user_id', '=', userId).execute();
    await trx.deleteFrom('identities').where('user_id', '=', userId).execute();
    await trx.deleteFrom('device_grants').where('user_id', '=', userId).execute();
    await trx.deleteFrom('refresh_tokens').where('user_id', '=', userId).execute();
    await trx.deleteFrom('api_keys').where('created_by', '=', userId).execute();
    await trx.deleteFrom('login_tokens').where('email', '=', String(user.email)).execute();
    let memberships = trx.deleteFrom('memberships').where('user_id', '=', userId);
    if (sole.length > 0) memberships = memberships.where('workspace_id', 'not in', sole);
    await memberships.execute();
    await trx
      .updateTable('devices')
      .set({ name: DELETED_DEVICE_NAME, revoked_at: sql<Date>`coalesce(revoked_at, now())` })
      .where('user_id', '=', userId)
      .execute();
    await trx
      .updateTable('users')
      .set({
        email: scrubbedEmail(userId),
        display_name: DELETED_USER_NAME,
        avatar_slot: null,
        locale: 'en',
        telemetry_opt_in: false,
        status: 'deleted',
        deleted_at: now,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', userId)
      .execute();
    await sql`select pseudonymise_audit_user(${userId})`.execute(trx);
    await auditPurge(deps, trx, 'scrubbed');
    return true;
  });
}

/**
 * Steps 5-6: deletes the workspaces the user was alone in (again on a retry: deleting is
 * idempotent), then what nobody else references; `waiting` while those workspaces remain.
 */
async function finish(
  deps: PurgeDeps,
  userId: string,
): Promise<'deleted' | 'scrubbed' | 'waiting'> {
  for (const workspaceId of await soleWorkspaces(deps.db, userId)) {
    await deps.deleteWorkspace(workspaceId);
  }
  const remaining = await deps.db
    .selectFrom('memberships')
    .select('id')
    .where('user_id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  if (remaining !== undefined) return 'waiting';
  await deps.db
    .deleteFrom('devices')
    .where('user_id', '=', userId)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('session_members')
            .select('session_members.id')
            .whereRef('session_members.device_id', '=', 'devices.id'),
        ),
      ),
    )
    .execute();
  try {
    await withTransaction(deps.db, async (trx) => {
      const result = await trx.deleteFrom('users').where('id', '=', userId).executeTakeFirst();
      if (Number(result.numDeletedRows) > 0) await auditPurge(deps, trx, 'deleted');
    });
  } catch (err) {
    // 23503: other people's records (a workspace they created, a session they joined) point at it.
    if ((err as { code?: unknown } | null)?.code === '23503') return 'scrubbed';
    throw err;
  }
  return 'deleted';
}

/**
 * `PurgeDeps.deleteWorkspace` over B027's `WorkspaceService.softDelete`: the workspace is deleted
 * as its owner would (hidden, `workspace.delete` audited by the system actor `account-purge`,
 * the `workspace-purge` job queued). A workspace that is already gone resolves, so a retry is
 * safe.
 */
export function workspaceDeleterFrom(
  workspaces: Pick<WorkspaceService, 'softDelete'>,
  emitter: Pick<AuditEmitter, 'emit'>,
): (workspaceId: string) => Promise<void> {
  return async (workspaceId) => {
    try {
      await workspaces.softDelete(workspaceId, undefined, {
        audit: (trx, input) =>
          emitter.emit(trx, {
            workspaceId: null,
            actor: { type: 'system', id: PURGE_ACTOR },
            outcome: 'success',
            ...input,
          }),
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') return;
      throw err;
    }
  };
}

/** Users whose deletion deadline is at or before `now`, oldest first (the purge sweep's input). */
export async function duePurges(db: Kysely<PurgeDb>, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .selectFrom('users')
    .select('id')
    .where('status', '=', 'pending_deletion')
    .where('deletion_scheduled_at', '<=', now)
    .orderBy('deletion_scheduled_at')
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

/** Purges `userId` when their deletion is due (see the module comment for each outcome). */
export async function purgeUser(deps: PurgeDeps, userId: string): Promise<PurgeOutcome> {
  const metrics = deps.metrics ?? noopMetrics;
  const now = new Date((deps.clock ?? Date.now)());
  const user = await deps.db
    .selectFrom('users')
    .select(['status', 'deletion_scheduled_at'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user === undefined) return 'gone';
  if (user.status === 'active') return 'cancelled';
  if (user.status === 'pending_deletion') {
    if (user.deletion_scheduled_at === null) return 'cancelled';
    if (user.deletion_scheduled_at > now) return 'not_due';
    // PurgeDb holds every LifecycleDb table; Kysely's invariance needs the narrowing spelled out.
    const lifecycleDb = deps.db as unknown as Kysely<LifecycleDb>;
    if ((await blockingWorkspaces(lifecycleDb, userId)).length > 0) {
      metrics.counter('account_purge_blocked_total').inc();
      deps.logger?.warn({ user_id: userId }, 'account_purge.blocked_by_sole_ownership');
      return 'blocked';
    }
    if (!(await removePersonalData(deps, userId, now))) return 'cancelled';
  }
  const outcome = await finish(deps, userId);
  metrics.counter('account_purges_total', { outcome }).inc();
  deps.logger?.info({ user_id: userId, outcome }, 'account_purge.done');
  return outcome;
}
