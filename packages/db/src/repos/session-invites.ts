/**
 * Session invites (B105): the Postgres side.
 *
 * - An invite is found by the sha256 of its token only; the status comes from its columns and the
 *   time (`sessionInviteStatus`), as for workspace invites (B029).
 * - Accepting records the grant (`accepted_by`) and uses no seat and creates no membership.
 * - A grant is an accepted, not revoked invite: `grantFor` is what the join route and the relay
 *   read. Revoking drops the bundle and the grant.
 * - A key bundle is opaque bytes: stored, handed out once, dropped on revocation or expiry.
 *
 * Owns: the SQL of session invites. Must not: store or return a token, or return a key bundle
 * anywhere but `takeKeyBundle`.
 */
import { paginate, type Page, type PageParams } from '@centcom/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { SessionInviteDatabase } from '../schema/session-invites.js';
import { withTransaction } from '../tx.js';

export type SessionInviteRole = 'editor' | 'viewer';
export type SessionInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** A session invite as callers see it (never its token or key bundle). */
export interface SessionInviteRecord {
  id: string;
  sessionId: string;
  workspaceId: string | null;
  email: string | null;
  role: SessionInviteRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  expiredAt: Date | null;
  shareHistory: boolean;
  hasKeyBundle: boolean;
}

export interface NewSessionInvite {
  id: string;
  sessionId: string;
  workspaceId: string | null;
  email: string | null;
  role: SessionInviteRole;
  tokenHash: Buffer;
  createdBy: string;
  expiresAt: Date;
  shareHistory: boolean;
}

export function sessionInviteStatus(invite: SessionInviteRecord, now: Date): SessionInviteStatus {
  if (invite.revokedAt !== null) return 'revoked';
  if (invite.acceptedAt !== null) return 'accepted';
  if (invite.expiredAt !== null || invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** What a public preview shows. */
export interface SessionInvitePreviewRow {
  invite: SessionInviteRecord;
  sessionName: string;
  workspaceName: string;
  inviterName: string;
  sessionState: string;
}

export interface SessionInviteStore {
  /** Inserts the invite; null, writing nothing, when the address has a pending invite there. */
  insert(input: NewSessionInvite, now: Date): Promise<SessionInviteRecord | null>;
  findById(inviteId: string): Promise<SessionInviteRecord | null>;
  /** The invite of a token hash with the names a preview shows; null when there is none. */
  preview(tokenHash: Buffer): Promise<SessionInvitePreviewRow | null>;
  /** Pending invites of a session at `now`, oldest first (sort `created`). */
  listPending(sessionId: string, now: Date, params: PageParams): Promise<Page<SessionInviteRecord>>;
  /**
   * Accepts the token's invite for `userId` in one transaction with its row locked: `check` sees
   * the invite (and the user's address) and may refuse by throwing; `{kind: 'again'}` when the
   * same user already accepted it. null for an unknown token.
   */
  accept<T>(
    tokenHash: Buffer,
    userId: string,
    now: Date,
    bundleExpiresAt: Date,
    check: (invite: SessionInviteRecord, userEmail: string | null) => Promise<T>,
  ): Promise<{ kind: 'accepted' | 'again'; invite: SessionInviteRecord; value: T } | null>;
  /** Revokes the invite and drops its bundle; false when it was already revoked or is unknown. */
  revoke(inviteId: string, at: Date): Promise<boolean>;
  /** The live grant of `userId` to `sessionId` (accepted, not revoked), or null. */
  grantFor(
    sessionId: string,
    userId: string,
  ): Promise<{ role: SessionInviteRole; inviteId: string } | null>;
  putKeyBundle(inviteId: string, bundle: Buffer, expiresAt: Date): Promise<void>;
  takeKeyBundle(inviteId: string, userId: string, at: Date): Promise<Buffer | null>;
  /** Marks lapsed pending invites expired and drops stale bundles. */
  sweep(now: Date): Promise<{ expired: number; bundlesDropped: number }>;
}

export const SESSION_INVITE_LIST_SORTS = ['created'] as const;

type Db = Kysely<SessionInviteDatabase> | Transaction<SessionInviteDatabase>;

const COLUMNS = [
  'session_invites.id',
  'session_invites.session_id',
  'session_invites.workspace_id',
  'session_invites.role',
  'session_invites.created_by',
  'session_invites.created_at',
  'session_invites.expires_at',
  'session_invites.accepted_at',
  'session_invites.accepted_by',
  'session_invites.revoked_at',
  'session_invites.expired_at',
  'session_invites.share_history',
] as const;

const select = (db: Db) =>
  db
    .selectFrom('session_invites')
    .select(COLUMNS)
    .select([
      sql<string | null>`session_invites.email::text`.as('email'),
      sql<boolean>`session_invites.key_bundle is not null`.as('has_key_bundle'),
    ]);

type Row = Awaited<ReturnType<ReturnType<typeof select>['executeTakeFirstOrThrow']>>;

const toRecord = (row: Row): SessionInviteRecord => ({
  id: row.id,
  sessionId: row.session_id,
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
});

/** The session invite store over `database`. */
export function createSessionInviteStore<DB extends SessionInviteDatabase>(
  database: Kysely<DB>,
): SessionInviteStore {
  const db = database as unknown as Kysely<SessionInviteDatabase>;
  return {
    async insert(input, now) {
      // A lapsed pending invite of the same address makes room for the new one.
      if (input.email !== null) {
        await db
          .updateTable('session_invites')
          .set({ expired_at: now })
          .where('session_id', '=', input.sessionId)
          .where(sql<boolean>`email = ${input.email}`)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .where('expired_at', 'is', null)
          .where('expires_at', '<=', now)
          .execute();
      }
      const inserted = await db
        .insertInto('session_invites')
        .values({
          id: input.id,
          session_id: input.sessionId,
          workspace_id: input.workspaceId,
          email: input.email,
          role: input.role,
          token_hash: input.tokenHash,
          created_by: input.createdBy,
          expires_at: input.expiresAt,
          share_history: input.shareHistory,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) return null;
      return this.findById(input.id);
    },
    async findById(inviteId) {
      const row = await select(db).where('session_invites.id', '=', inviteId).executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },
    async preview(tokenHash) {
      const row = await select(db)
        .innerJoin('sessions', 'sessions.id', 'session_invites.session_id')
        .innerJoin('users', 'users.id', 'session_invites.created_by')
        .leftJoin('workspaces', 'workspaces.id', 'session_invites.workspace_id')
        .select([
          'sessions.name as session_name',
          'sessions.state as session_state',
          'users.display_name as inviter_name',
          'workspaces.name as workspace_name',
        ])
        .where('session_invites.token_hash', '=', tokenHash)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        invite: toRecord(row),
        sessionName: row.session_name,
        workspaceName: row.workspace_name ?? '',
        inviterName: row.inviter_name,
        sessionState: row.session_state,
      };
    },
    async listPending(sessionId, now, params) {
      const result = await paginate(
        select(db)
          .where('session_invites.session_id', '=', sessionId)
          .where('session_invites.accepted_at', 'is', null)
          .where('session_invites.revoked_at', 'is', null)
          .where('session_invites.expired_at', 'is', null)
          .where('session_invites.expires_at', '>', now),
        {
          sorts: { created: { column: 'session_invites.created_at', direction: 'asc' } },
          idColumn: 'session_invites.id',
        },
        params,
      );
      return { ...result, data: result.data.map(toRecord) };
    },
    async accept(tokenHash, userId, now, bundleExpiresAt, check) {
      return withTransaction(db, async (trx) => {
        const row = await select(trx)
          .where('session_invites.token_hash', '=', tokenHash)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return null;
        const invite = toRecord(row);
        const user = await trx
          .selectFrom('users')
          .select(sql<string | null>`email::text`.as('email'))
          .where('id', '=', userId)
          .executeTakeFirst();
        const value = await check(invite, user?.email ?? null);
        if (sessionInviteStatus(invite, now) === 'accepted' && invite.acceptedBy === userId) {
          return { kind: 'again' as const, invite, value };
        }
        await trx
          .updateTable('session_invites')
          .set({ accepted_at: now, accepted_by: userId })
          .set({
            key_bundle_expires_at: sql<Date | null>`case when key_bundle is not null then ${bundleExpiresAt}::timestamptz end`,
          })
          .where('id', '=', invite.id)
          .execute();
        return {
          kind: 'accepted' as const,
          invite: { ...invite, acceptedAt: now, acceptedBy: userId },
          value,
        };
      });
    },
    async revoke(inviteId, at) {
      const r = await db
        .updateTable('session_invites')
        .set({ revoked_at: at, key_bundle_expires_at: null })
        .where('id', '=', inviteId)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (r !== undefined) {
        await sql`update session_invites set key_bundle = null where id = ${inviteId}`.execute(db);
      }
      return r !== undefined;
    },
    async grantFor(sessionId, userId) {
      const row = await db
        .selectFrom('session_invites')
        .select(['id', 'role'])
        .where('session_id', '=', sessionId)
        .where('accepted_by', '=', userId)
        .where('revoked_at', 'is', null)
        .orderBy('accepted_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : { role: row.role, inviteId: row.id };
    },
    async putKeyBundle(inviteId, bundle, expiresAt) {
      await sql`update session_invites set key_bundle = ${bundle}, key_bundle_expires_at = ${expiresAt}, key_bundle_fetched_at = null where id = ${inviteId} and revoked_at is null`.execute(
        db,
      );
    },
    async takeKeyBundle(inviteId, userId, at) {
      const r = await sql<{ key_bundle: Buffer | null }>`
        with old as (select id, key_bundle from session_invites where id = ${inviteId} and accepted_by = ${userId} and revoked_at is null and key_bundle is not null and key_bundle_expires_at > ${at} for update)
        update session_invites s set key_bundle = null, key_bundle_expires_at = null, key_bundle_fetched_at = ${at} from old where s.id = old.id returning old.key_bundle`.execute(
        db,
      );
      return r.rows[0]?.key_bundle ?? null;
    },
    async sweep(now) {
      const expired = await db
        .updateTable('session_invites')
        .set({ expired_at: now })
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where('expired_at', 'is', null)
        .where('expires_at', '<=', now)
        .returning('id')
        .execute();
      const dropped =
        await sql`update session_invites set key_bundle = null, key_bundle_expires_at = null where key_bundle is not null and key_bundle_expires_at <= ${now}`.execute(
          db,
        );
      return { expired: expired.length, bundlesDropped: Number(dropped.numAffectedRows ?? 0) };
    },
  };
}
