/**
 * Table types of share links (B068, migration 20260102005000_share_links.sql): viewer-only links
 * (only the token's SHA-256 is stored) and the guests who joined through them.
 */
import type { ColumnType, Generated } from 'kysely';
import type { CreatedAt } from './core.js';

/** `share_link`: one link of a session. */
export interface ShareLinkTable {
  id: Generated<string>;
  session_id: ColumnType<string, string, never>;
  /** SHA-256 of the token. */
  token_hash: ColumnType<Buffer, Buffer, never>;
  expires_at: ColumnType<Date, Date | string, never>;
  max_uses: ColumnType<number, number, never>;
  uses: ColumnType<number, number | undefined, number>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_by_member: ColumnType<string, string, never>;
  created_at: CreatedAt;
}

/** `guest_member`: a guest who joined through a link. */
export interface GuestMemberTable {
  member_id: ColumnType<string, string, never>;
  session_id: ColumnType<string, string, never>;
  share_link_id: ColumnType<string, string, never>;
  name: ColumnType<string, string, never>;
  slot: ColumnType<number, number, never>;
  created_at: CreatedAt;
}

/** The share-link tables. */
export interface ShareLinkTables {
  share_link: ShareLinkTable;
  guest_member: GuestMemberTable;
}
