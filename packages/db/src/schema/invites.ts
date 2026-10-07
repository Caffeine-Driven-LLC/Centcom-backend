/**
 * Table types of workspace invites (B029, migration 20260102000800_invites.sql). Only the
 * sha256 of an invite's token is stored; `key_bundle` is opaque ciphertext (CT-CRYPTO §4).
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A timestamp set once, later. */
type LaterTimestamp = ColumnType<Date | null, never, Date>;

export interface InvitesTable {
  /** `inv_` id. */
  id: ColumnType<string, string, never>;
  workspace_id: ColumnType<string, string, never>;
  /** The invitee's address (lower case), or null for a link invite. */
  email: ColumnType<string | null, string | null, never>;
  role: ColumnType<
    'admin' | 'member' | 'billing' | 'guest',
    'admin' | 'member' | 'billing' | 'guest',
    never
  >;
  /** sha256 of the token. */
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

/** The invites table. */
export interface InvitesDatabase {
  invites: InvitesTable;
}

/** What the invite store reads and writes: the core tables and invites. */
export type InviteDatabase = CoreDatabase & InvitesDatabase;
