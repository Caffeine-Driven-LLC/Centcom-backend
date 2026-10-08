/**
 * Where the account lifecycle (B026) keeps its state: the deletion schedule on `users`, the
 * `account_exports` rows, and the reads an export is built from. `createAccountLifecycleStore` is
 * the Postgres implementation; tests use a fake with the same rules.
 *
 * - `scheduleDeletion` runs in one transaction that locks the user's row: it refuses when the user
 *   is the only owner of a live workspace that has other members, sets the schedule only when none
 *   is pending (a repeated request keeps the first), and revokes every refresh token and device of
 *   the user in that same transaction, so a crash cannot leave a scheduled but active account.
 * - `createExport` locks the user's row too, so of two concurrent requests within the 24-hour
 *   limit exactly one is created.
 * - Export reads cover the caller's own rows only: their memberships (never the other members),
 *   their API keys without the hash, their devices' public fingerprints, their own audit events.
 *
 * Owns: the SQL above. Must not: read or write another user's rows, or select a secret column
 * (`key_hash`, token hashes).
 */
import {
  USER_COLUMNS,
  withTransaction,
  type AccountExportStatus,
  type AccountLifecycleDatabase,
  type ApiKeysDatabase,
  type NotificationPrefDatabase,
  type RefreshTokensDatabase,
  type User,
} from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';

/** The tables this module reads and writes. */
export type LifecycleDb = AccountLifecycleDatabase &
  RefreshTokensDatabase &
  ApiKeysDatabase &
  NotificationPrefDatabase;

/** An export row, as the service and the runner see it. */
export interface ExportRow {
  id: string;
  userId: string;
  status: AccountExportStatus;
  blobKey: string | null;
  sizeBytes: number | null;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/** What `scheduleDeletion` did. */
export type ScheduleOutcome =
  | {
      kind: 'scheduled' | 'already';
      scheduledFor: Date;
      /** The devices revoked by this call (their access tokens must be flagged now). */
      revokedDevices: string[];
    }
  | { kind: 'blocked'; workspaceIds: string[] }
  | { kind: 'missing' };

/** What `restore` did. */
export type RestoreOutcome =
  | { kind: 'restored'; user: User }
  | { kind: 'not_pending' }
  | { kind: 'expired' }
  | { kind: 'missing' };

/** What `createExport` did. */
export type CreateExportOutcome =
  { kind: 'created' } | { kind: 'limited'; latest: Date } | { kind: 'missing' };

/** A user's records, for the export document. */
export interface ExportData {
  user: User & { deletion_scheduled_at: Date | null };
  devices: {
    id: string;
    name: string;
    platform: string;
    fingerprint: string;
    created_at: Date;
    last_seen_at: Date | null;
    revoked_at: Date | null;
  }[];
  memberships: { id: string; workspace_id: string; role: string; created_at: Date }[];
  apiKeys: {
    id: string;
    workspace_id: string;
    name: string;
    mode: string;
    prefix: string;
    scope: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
  }[];
  notificationPreferences: Record<string, unknown> | null;
  auditEvents: {
    id: string;
    workspace_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    outcome: string;
    created_at: Date;
  }[];
}

/** Where the lifecycle's state lives. */
export interface AccountLifecycleStore {
  /**
   * Schedules the deletion of `userId` for `scheduledFor` (unless one is pending) and revokes the
   * user's tokens and devices, in one transaction; `audit` writes the event in it.
   */
  scheduleDeletion(
    userId: string,
    at: Date,
    scheduledFor: Date,
    audit: (trx: Transaction<LifecycleDb>, scheduledFor: Date) => Promise<unknown>,
  ): Promise<ScheduleOutcome>;
  /** Ends a pending deletion before its deadline; `audit` writes the event in the transaction. */
  restore(
    userId: string,
    now: Date,
    audit: (trx: Transaction<LifecycleDb>) => Promise<unknown>,
  ): Promise<RestoreOutcome>;
  /** Clears a pending deletion whatever the time; true when there was one. */
  cancelDeletion(userId: string): Promise<boolean>;
  /**
   * Creates an export unless a non-failed one was created after `since`; `audit` writes the event
   * in the transaction.
   */
  createExport(
    row: { id: string; userId: string; createdAt: Date },
    since: Date,
    audit: (trx: Transaction<LifecycleDb>) => Promise<unknown>,
  ): Promise<CreateExportOutcome>;
  /** The user's export, or null (another user's export is null too). */
  getExport(userId: string, exportId: string): Promise<ExportRow | null>;
  /** Marks a pending or running export running and returns it; null for any other state. */
  claimExport(exportId: string): Promise<ExportRow | null>;
  /** The records the export of `userId` holds; null when the user is gone. */
  exportData(userId: string, auditLimit: number): Promise<ExportData | null>;
  /** A running export is ready: its file, size and expiry. */
  markReady(exportId: string, blobKey: string, sizeBytes: number, expiresAt: Date): Promise<void>;
  /** A pending or running export failed, with a safe code. */
  markFailed(exportId: string, errorCode: string): Promise<void>;
  /** Up to `limit` ready exports whose file expired at or before `now`. */
  dueForExpiry(now: Date, limit: number): Promise<ExportRow[]>;
  /** A ready export is expired: its file is gone. */
  markExpired(exportId: string): Promise<void>;
  /** Pending exports created before `before` (their job may never have been queued). */
  stalePending(before: Date, limit: number): Promise<string[]>;
}

type ExportSelect = {
  id: string;
  user_id: string;
  status: AccountExportStatus;
  blob_key: string | null;
  size_bytes: string | null;
  error_code: string | null;
  created_at: Date;
  expires_at: Date | null;
};

const toExportRow = (r: ExportSelect): ExportRow => ({
  id: r.id,
  userId: r.user_id,
  status: r.status,
  blobKey: r.blob_key,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  errorCode: r.error_code,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/**
 * The live workspaces `userId` is the only owner of while other people are members: deleting the
 * account would orphan them (CT-RBAC: a workspace always has an owner).
 */
export async function blockingWorkspaces(
  db: Kysely<LifecycleDb> | Transaction<LifecycleDb>,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('memberships as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .select('m.workspace_id')
    .where('m.user_id', '=', userId)
    .where('m.role', '=', 'owner')
    .where('w.deleted_at', 'is', null)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('memberships as o')
            .select('o.id')
            .whereRef('o.workspace_id', '=', 'm.workspace_id')
            .where('o.user_id', '<>', userId)
            .where('o.role', '=', 'owner'),
        ),
      ),
    )
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('memberships as o')
          .select('o.id')
          .whereRef('o.workspace_id', '=', 'm.workspace_id')
          .where('o.user_id', '<>', userId),
      ),
    )
    .orderBy('m.workspace_id')
    .execute();
  return rows.map((r) => r.workspace_id);
}

/** The lifecycle store in Postgres. */
export function createAccountLifecycleStore(db: Kysely<LifecycleDb>): AccountLifecycleStore {
  /** Locks the user's row; null when there is none or it is purged. */
  const lockUser = (trx: Transaction<LifecycleDb>, userId: string) =>
    trx
      .selectFrom('users')
      .select(['id', 'status', 'deletion_scheduled_at'])
      .where('id', '=', userId)
      .where('status', '<>', 'deleted')
      .forUpdate()
      .executeTakeFirst();

  return {
    scheduleDeletion(userId, at, scheduledFor, audit) {
      return withTransaction(db, async (trx) => {
        const user = await lockUser(trx, userId);
        if (user === undefined) return { kind: 'missing' } as const;
        let kind: 'scheduled' | 'already' = 'already';
        let deadline = user.deletion_scheduled_at ?? scheduledFor;
        if (user.status !== 'pending_deletion' || user.deletion_scheduled_at === null) {
          const blockers = await blockingWorkspaces(trx, userId);
          if (blockers.length > 0) return { kind: 'blocked', workspaceIds: blockers } as const;
          await trx
            .updateTable('users')
            .set({
              status: 'pending_deletion',
              deletion_requested_at: at,
              deletion_scheduled_at: scheduledFor,
              updated_at: sql<Date>`now()`,
            })
            .where('id', '=', userId)
            .execute();
          kind = 'scheduled';
          deadline = scheduledFor;
          await audit(trx, deadline);
        }
        // Every request revokes again: a device signed in since the first one goes too.
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: at })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();
        const revoked = await trx
          .updateTable('devices')
          .set({ revoked_at: at })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .returning('id')
          .execute();
        return { kind, scheduledFor: deadline, revokedDevices: revoked.map((r) => r.id) };
      });
    },

    restore(userId, now, audit) {
      return withTransaction(db, async (trx) => {
        const user = await lockUser(trx, userId);
        if (user === undefined) return { kind: 'missing' } as const;
        if (user.status !== 'pending_deletion') return { kind: 'not_pending' } as const;
        if (user.deletion_scheduled_at !== null && user.deletion_scheduled_at <= now) {
          return { kind: 'expired' } as const;
        }
        const restored = await trx
          .updateTable('users')
          .set({
            status: 'active',
            deletion_requested_at: null,
            deletion_scheduled_at: null,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', userId)
          .returning([...USER_COLUMNS])
          .executeTakeFirstOrThrow();
        await audit(trx);
        return { kind: 'restored', user: restored } as const;
      });
    },

    async cancelDeletion(userId) {
      const result = await db
        .updateTable('users')
        .set({
          status: 'active',
          deletion_requested_at: null,
          deletion_scheduled_at: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', userId)
        .where('status', '=', 'pending_deletion')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    createExport(row, since, audit) {
      return withTransaction(db, async (trx) => {
        const user = await lockUser(trx, row.userId);
        if (user === undefined) return { kind: 'missing' } as const;
        const latest = await trx
          .selectFrom('account_exports')
          .select('created_at')
          .where('user_id', '=', row.userId)
          .where('status', '<>', 'failed')
          .where('created_at', '>', since)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (latest !== undefined) return { kind: 'limited', latest: latest.created_at } as const;
        await trx
          .insertInto('account_exports')
          .values({ id: row.id, user_id: row.userId, created_at: row.createdAt })
          .execute();
        await audit(trx);
        return { kind: 'created' } as const;
      });
    },

    async getExport(userId, exportId) {
      const row = await db
        .selectFrom('account_exports')
        .selectAll()
        .where('id', '=', exportId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row === undefined ? null : toExportRow(row);
    },

    async claimExport(exportId) {
      const row = await db
        .updateTable('account_exports')
        .set({ status: 'running', updated_at: sql<Date>`now()` })
        .where('id', '=', exportId)
        .where('status', 'in', ['pending', 'running'])
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toExportRow(row);
    },

    async exportData(userId, auditLimit) {
      const user = await db
        .selectFrom('users')
        .select([...USER_COLUMNS, 'deletion_scheduled_at'])
        .where('id', '=', userId)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      if (user === undefined) return null;
      const [devices, memberships, apiKeys, prefs, auditEvents] = await Promise.all([
        db
          .selectFrom('devices')
          .select([
            'id',
            'name',
            'platform',
            'fingerprint',
            'created_at',
            'last_seen_at',
            'revoked_at',
          ])
          .where('user_id', '=', userId)
          .orderBy('created_at')
          .orderBy('id')
          .execute(),
        db
          .selectFrom('memberships')
          .select(['id', 'workspace_id', 'role', 'created_at'])
          .where('user_id', '=', userId)
          .orderBy('created_at')
          .orderBy('id')
          .execute(),
        db
          .selectFrom('api_keys')
          .select([
            'id',
            'workspace_id',
            'name',
            'mode',
            'prefix',
            'scope',
            'created_at',
            'last_used_at',
            'expires_at',
            'revoked_at',
          ])
          .where('created_by', '=', userId)
          .orderBy('created_at')
          .orderBy('id')
          .execute(),
        db
          .selectFrom('notification_pref')
          .select('doc')
          .where('user_id', '=', userId)
          .executeTakeFirst(),
        db
          .selectFrom('audit_events')
          .select([
            'id',
            'workspace_id',
            'action',
            'target_type',
            'target_id',
            'outcome',
            'created_at',
          ])
          .where('actor_type', '=', 'user')
          .where('actor_id', '=', userId)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(auditLimit)
          .execute(),
      ]);
      return {
        user,
        devices,
        memberships,
        apiKeys,
        notificationPreferences: (prefs?.doc as Record<string, unknown> | undefined) ?? null,
        auditEvents,
      };
    },

    async markReady(exportId, blobKey, sizeBytes, expiresAt) {
      await db
        .updateTable('account_exports')
        .set({
          status: 'ready',
          blob_key: blobKey,
          size_bytes: sizeBytes,
          expires_at: expiresAt,
          error_code: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', exportId)
        .where('status', 'in', ['pending', 'running'])
        .execute();
    },

    async markFailed(exportId, errorCode) {
      await db
        .updateTable('account_exports')
        .set({ status: 'failed', error_code: errorCode, updated_at: sql<Date>`now()` })
        .where('id', '=', exportId)
        .where('status', 'in', ['pending', 'running'])
        .execute();
    },

    async dueForExpiry(now, limit) {
      const rows = await db
        .selectFrom('account_exports')
        .selectAll()
        .where('status', '=', 'ready')
        .where('expires_at', '<=', now)
        .orderBy('expires_at')
        .limit(limit)
        .execute();
      return rows.map(toExportRow);
    },

    async markExpired(exportId) {
      await db
        .updateTable('account_exports')
        .set({ status: 'expired', updated_at: sql<Date>`now()` })
        .where('id', '=', exportId)
        .where('status', '=', 'ready')
        .execute();
    },

    async stalePending(before, limit) {
      const rows = await db
        .selectFrom('account_exports')
        .select('id')
        .where('status', '=', 'pending')
        .where('created_at', '<', before)
        .orderBy('created_at')
        .limit(limit)
        .execute();
      return rows.map((r) => r.id);
    },
  };
}
