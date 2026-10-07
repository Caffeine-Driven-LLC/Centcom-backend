/**
 * Workspace invites (B029): the Postgres side.
 *
 * - An invite is found by the sha256 of its token only (the token itself is never stored); its
 *   status comes from its columns and the time (`inviteStatus`).
 * - `transaction(fn)` runs `fn` with the operations a change needs, in one transaction, including
 *   B028's membership operations: accepting locks the invite row, then the workspace row, and
 *   adds the member, so the seat check and the insert see the same members.
 * - A key bundle is opaque bytes: stored, handed out once (deleted as it is read), dropped on
 *   revocation, expiry, or 15 minutes after acceptance (`sweep`).
 * - A purged workspace's invites go through `deleteForWorkspace` (B027's purge hook), as the
 *   foreign key restricts.
 *
 * Owns: the SQL of invites. Must not: store or return a token, or return a key bundle anywhere
 * but `takeKeyBundle`.
 */
import { paginate, type AuditDb, type Page, type PageParams } from '@centcom/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { InviteDatabase } from '../schema/invites.js';
import type { CoreDatabase } from '../schema/core.js';
import { withTransaction } from '../tx.js';
import { memberOperations, type MemberTx } from './members.js';

/** A role an invite may give (never `owner`). */
export type InviteRole = 'admin' | 'member' | 'billing' | 'guest';
/** Where an invite stands. */
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invite, as callers see it (never its token or key bundle). */
export interface InviteRecord {
  /** `inv_` id. */
  id: string;
  workspaceId: string;
  /** The invitee's address, or null for a link invite. */
  email: string | null;
  role: InviteRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  expiredAt: Date | null;
  shareHistory: boolean;
  hasKeyBundle: boolean;
  keyBundleFetchedAt: Date | null;
}

/** An invite to insert. */
export interface NewInvite {
  id: string;
  workspaceId: string;
  email: string | null;
  role: InviteRole;
  /** sha256 of the token, 32 bytes. */
  tokenHash: Buffer;
  createdBy: string;
  expiresAt: Date;
  shareHistory: boolean;
}

/** The status of `invite` at `now`: revoked, accepted, expired (at `expires_at` exactly), or pending. */
export function inviteStatus(invite: InviteRecord, now: Date): InviteStatus {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.acceptedAt !== null) return 'accepted';
  if (invite.expiredAt !== null || invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** The operations of one transaction. */
export interface InviteTx {
  /** The transaction itself: audit events written through it commit with the change. */
  readonly trx: AuditDb;
  /** B028's membership operations in the same transaction. */
  readonly members: MemberTx;
  /** Inserts the invite; null, writing nothing, when the address has a pending invite there. */
  insert(input: NewInvite): Promise<InviteRecord | null>;
  /** Marks expired the address's pending invite in the workspace if its time is up. */
  expireLapsed(workspaceId: string, email: string, now: Date): Promise<void>;
  /** The invite of a token hash, its row locked until commit; null when there is none. */
  lockByToken(tokenHash: Buffer): Promise<InviteRecord | null>;
  /** The invite, its row locked until commit; null when there is none. */
  lockById(inviteId: string): Promise<InviteRecord | null>;
  /** Marks the invite accepted by `userId`; a key bundle it holds then lasts until `bundleExpiresAt`. */
  markAccepted(inviteId: string, userId: string, at: Date, bundleExpiresAt: Date): Promise<void>;
  /** Marks the invite revoked and drops its key bundle. */
  markRevoked(inviteId: string, at: Date): Promise<void>;
  /** Stores (or replaces) the invite's key bundle, kept until `expiresAt`. */
  putKeyBundle(inviteId: string, bundle: Buffer, expiresAt: Date): Promise<void>;
  /** The invite's key bundle, deleted as it is read; null when there is none (or it is past its time). */
  takeKeyBundle(inviteId: string, at: Date): Promise<Buffer | null>;
  /** Whether `userId` hosts a session of the workspace that has not ended. */
  hostsSessionIn(workspaceId: string, userId: string): Promise<boolean>;
  /** The user's address, or null when there is no such user. */
  emailOf(userId: string): Promise<string | null>;
  /** Whether a member of the workspace has this address. */
  isMemberEmail(workspaceId: string, email: string): Promise<boolean>;
}

/** What a public preview shows, with the invite it belongs to. */
export interface InvitePreviewRow {
  invite: InviteRecord;
  workspaceName: string;
  inviterName: string;
}

/** Invite persistence. */
export interface InviteStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: InviteTx) => Promise<T>): Promise<T>;
  /** One page of the workspace's pending invites at `now`, oldest first (sort `created`). */
  listPending(workspaceId: string, now: Date, params: PageParams): Promise<Page<InviteRecord>>;
  /** The invite, whatever its status, or null. */
  findById(inviteId: string): Promise<InviteRecord | null>;
  /** The invite of a token hash, of a live workspace, with the names a preview shows; or null. */
  preview(tokenHash: Buffer): Promise<InvitePreviewRow | null>;
  /**
   * Marks lapsed pending invites expired and drops their bundles, and drops bundles past their
   * own time (accepted 15 minutes ago and never fetched). Returns how many of each.
   */
  sweep(now: Date): Promise<{ expired: number; bundlesDropped: number }>;
  /**
   * Deletes the invites of a soft-deleted workspace (B027's purge hook); returns how many. Does
   * nothing for a live workspace.
   */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

/** The sorts of `listPending`. */
export const INVITE_LIST_SORTS = ['created'] as const;

type Db = Kysely<InviteDatabase> | Transaction<InviteDatabase>;

const COLUMNS = [
  'invites.id',
  'invites.workspace_id',
  'invites.role',
  'invites.created_by',
  'invites.created_at',
  'invites.expires_at',
  'invites.accepted_at',
  'invites.accepted_by',
  'invites.revoked_at',
  'invites.expired_at',
  'invites.share_history',
  'invites.key_bundle_fetched_at',
] as const;

function invites(db: Db) {
  return db
    .selectFrom('invites')
    .select(COLUMNS)
    .select([
      sql<string | null>`invites.email::text`.as('email'),
      sql<boolean>`invites.key_bundle is not null`.as('has_key_bundle'),
    ]);
}

const toRecord = (row: {
  id: string;
  workspace_id: string;
  email: string | null;
  role: InviteRole;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
  expired_at: Date | null;
  share_history: boolean;
  has_key_bundle: boolean;
  key_bundle_fetched_at: Date | null;
}): InviteRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  email: row.email,
  role: row.role,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  acceptedAt: row.accepted_at,
  acceptedBy: row.accepted_by,
  revokedAt: row.revoked_at,
  expiredAt: row.expired_at,
  shareHistory: row.share_history,
  hasKeyBundle: row.has_key_bundle,
  keyBundleFetchedAt: row.key_bundle_fetched_at,
});

/** Invite operations inside `trx`, a transaction the caller holds. */
export function inviteOperations(trx: Transaction<InviteDatabase>): InviteTx {
  return {
    trx,
    members: memberOperations(trx as unknown as Transaction<CoreDatabase>),
    async insert(input) {
      const inserted = await trx
        .insertInto('invites')
        .values({
          id: input.id,
          workspace_id: input.workspaceId,
          email: input.email,
          role: input.role,
          token_hash: input.tokenHash,
          created_by: input.createdBy,
          expires_at: input.expiresAt,
          share_history: input.shareHistory,
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'email'])
            .where('email', 'is not', null)
            .where('accepted_at', 'is', null)
            .where('revoked_at', 'is', null)
            .where('expired_at', 'is', null)
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) return null;
      const row = await invites(trx).where('invites.id', '=', input.id).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async expireLapsed(workspaceId, email, now) {
      await trx
        .updateTable('invites')
        .set({ expired_at: now, key_bundle: null, key_bundle_expires_at: null })
        .where('workspace_id', '=', workspaceId)
        .where('email', '=', email)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expired_at', 'is', null)
        .where('expires_at', '<=', now)
        .execute();
    },
    async lockByToken(tokenHash) {
      const row = await invites(trx)
        .where('invites.token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async lockById(inviteId) {
      const row = await invites(trx)
        .where('invites.id', '=', inviteId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async markAccepted(inviteId, userId, at, bundleExpiresAt) {
      await trx
        .updateTable('invites')
        .set({
          accepted_at: at,
          accepted_by: userId,
          key_bundle_expires_at: sql<Date | null>`case when key_bundle is null then null else ${bundleExpiresAt}::timestamptz end`,
        })
        .where('id', '=', inviteId)
        .execute();
    },
    async markRevoked(inviteId, at) {
      await trx
        .updateTable('invites')
        .set({ revoked_at: at, key_bundle: null, key_bundle_expires_at: null })
        .where('id', '=', inviteId)
        .execute();
    },
    async putKeyBundle(inviteId, bundle, expiresAt) {
      await trx
        .updateTable('invites')
        .set({ key_bundle: bundle, key_bundle_expires_at: expiresAt })
        .where('id', '=', inviteId)
        .execute();
    },
    async takeKeyBundle(inviteId, at) {
      const row = await trx
        .selectFrom('invites')
        .select(['key_bundle', 'key_bundle_expires_at'])
        .where('id', '=', inviteId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined || row.key_bundle === null) return null;
      // A bundle past its time is gone, whether or not the expiry job has run yet.
      const live = row.key_bundle_expires_at !== null && row.key_bundle_expires_at > at;
      await trx
        .updateTable('invites')
        .set({
          key_bundle: null,
          key_bundle_expires_at: null,
          ...(live ? { key_bundle_fetched_at: at } : {}),
        })
        .where('id', '=', inviteId)
        .execute();
      return live ? row.key_bundle : null;
    },
    async hostsSessionIn(workspaceId, userId) {
      const row = await trx
        .selectFrom('session_members')
        .innerJoin('sessions', 'sessions.id', 'session_members.session_id')
        .select('session_members.id')
        .where('sessions.workspace_id', '=', workspaceId)
        .where('sessions.state', 'in', ['pending', 'live', 'paused'])
        .where('session_members.user_id', '=', userId)
        .where('session_members.role', '=', 'host')
        .where('session_members.left_at', 'is', null)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
    async emailOf(userId) {
      const row = await trx
        .selectFrom('users')
        .select(sql<string>`email::text`.as('email'))
        .where('id', '=', userId)
        .executeTakeFirst();
      return row?.email ?? null;
    },
    async isMemberEmail(workspaceId, email) {
      const row = await trx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('memberships.id')
        .where('memberships.workspace_id', '=', workspaceId)
        .where('users.email', '=', email)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

/** Invite persistence over `database` (any database type holding the core tables and invites). */
export function createInviteStore<DB extends InviteDatabase>(database: Kysely<DB>): InviteStore {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<InviteDatabase>;
  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(inviteOperations(trx))),

    async listPending(workspaceId, now, params) {
      const result = await paginate(
        invites(db)
          .where('invites.workspace_id', '=', workspaceId)
          .where('invites.accepted_at', 'is', null)
          .where('invites.revoked_at', 'is', null)
          .where('invites.expired_at', 'is', null)
          .where('invites.expires_at', '>', now),
        {
          sorts: { created: { column: 'invites.created_at', direction: 'asc' } },
          idColumn: 'invites.id',
        },
        params,
      );
      return { ...result, data: result.data.map(toRecord) };
    },

    async findById(inviteId) {
      const row = await invites(db).where('invites.id', '=', inviteId).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async preview(tokenHash) {
      const row = await invites(db)
        .innerJoin('workspaces', 'workspaces.id', 'invites.workspace_id')
        .innerJoin('users', 'users.id', 'invites.created_by')
        .select(['workspaces.name as workspace_name', 'users.display_name as inviter_name'])
        .where('invites.token_hash', '=', tokenHash)
        .where('workspaces.deleted_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        invite: toRecord(row),
        workspaceName: row.workspace_name,
        inviterName: row.inviter_name,
      };
    },

    async sweep(now) {
      const expired = await db
        .updateTable('invites')
        .set({ expired_at: now, key_bundle: null, key_bundle_expires_at: null })
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expired_at', 'is', null)
        .where('expires_at', '<=', now)
        .executeTakeFirst();
      const dropped = await db
        .updateTable('invites')
        .set({ key_bundle: null, key_bundle_expires_at: null })
        .where('key_bundle', 'is not', null)
        .where('key_bundle_expires_at', '<=', now)
        .executeTakeFirst();
      return {
        expired: Number(expired.numUpdatedRows),
        bundlesDropped: Number(dropped.numUpdatedRows),
      };
    },

    async deleteForWorkspace(workspaceId) {
      const deleted = await db
        .deleteFrom('invites')
        .where('workspace_id', '=', workspaceId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('workspaces')
              .select('workspaces.id')
              .where('workspaces.id', '=', workspaceId)
              .where('workspaces.deleted_at', 'is not', null),
          ),
        )
        .executeTakeFirst();
      return Number(deleted.numDeletedRows);
    },
  };
}
