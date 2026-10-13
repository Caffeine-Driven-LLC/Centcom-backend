/**
 * Table types of session invites (B105, migration 20260102005200_session_invites.sql). Only the
 * sha256 of a token is stored; `key_bundle` is opaque ciphertext (CT-CRYPTO section 4).
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

type LaterTimestamp = ColumnType<Date | null, never, Date>;

export interface SessionInvitesTable {
  /** `inv_` id. */
  id: ColumnType<string, string, never>;
  session_id: ColumnType<string, string, never>;
  workspace_id: ColumnType<string | null, string | null, never>;
  /** The invitee's address (lower case), or null for a link invite. */
  email: ColumnType<string | null, string | null, never>;
  role: ColumnType<'editor' | 'viewer', 'editor' | 'viewer', never>;
  token_hash: ColumnType<Buffer, Buffer, never>;
  created_by: ColumnType<string, string, never>;
  created_at: CreatedAt;
  expires_at: ColumnType<Date, Date, never>;
  accepted_at: LaterTimestamp;
  accepted_by: ColumnType<string | null, never, string>;
  revoked_at: LaterTimestamp;
  expired_at: LaterTimestamp;
  share_history: ColumnType<boolean, boolean | undefined, never>;
  key_bundle: ColumnType<Buffer | null, never, Buffer | null>;
  key_bundle_expires_at: ColumnType<Date | null, never, Date | null>;
  key_bundle_fetched_at: LaterTimestamp;
}

/** The session invites table. */
export interface SessionInvitesDatabase {
  session_invites: SessionInvitesTable;
}

/** What the session invite store reads and writes: the core tables and session invites. */
export type SessionInviteDatabase = CoreDatabase & SessionInvitesDatabase;
