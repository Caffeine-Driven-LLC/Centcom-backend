/**
 * Core schema v1 (B008): Kysely table types for migrations/20260101000000_core_schema.sql, the
 * tables every identity, workspace and session lane builds on. Enumerated columns use the
 * contract's types, so a value the contract does not know cannot be written.
 *
 * Owns: these interfaces, kept identical to the migration (a test compares them with
 * information_schema). Must not: describe a column the migrations do not create; a lane that
 * adds columns adds a migration and its own types.
 */
import type { Api } from '@centcom/contracts';
import type { ColumnType, Generated } from 'kysely';

/** A primary or foreign key fixed at insert: given then, never updated. */
export type FixedId = ColumnType<string, string, never>;
/** Set by the database on insert (`default now()`) and never changed. */
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** Defaults to now() on insert; the repository sets it on every update. */
export type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
/** A timestamp that is null until something happens (ended, revoked, ...). */
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

/** A JSON object column (`jsonb`); its shape is validated by the service layer. */
export type JsonObject = { [key: string]: unknown };

/** Lifecycle of a user account (B026 runs deletion). */
export type UserStatus = 'active' | 'pending_deletion' | 'deleted';

/** `users`: one row per account. */
export interface UsersTable {
  /** `usr_` id. */
  id: FixedId;
  /** Lower-cased by the API; unique ignoring case (citext). At most 254 characters. */
  email: string;
  /** 1-40 characters. */
  display_name: string;
  /** BCP 47 tag; default `en`. */
  locale: Generated<string>;
  /** The avatar slot identifier (the API's `avatar`), 1-64 characters. */
  avatar_slot: string | null;
  telemetry_opt_in: Generated<boolean>;
  status: Generated<UserStatus>;
  deletion_requested_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** `devices`: a CLI, TUI or browser a user signed in from, with its public keys (CT-CRYPTO). */
export interface DevicesTable {
  /** `dev_` id. */
  id: FixedId;
  user_id: FixedId;
  /** 1-80 characters. */
  name: string;
  platform: Api.Device['platform'];
  /** X25519 public key: 32 bytes, base64url without padding. */
  x25519_pub: string;
  /** Ed25519 public key: 32 bytes, base64url without padding. */
  ed25519_pub: string;
  /** `ABCD-EFGH-IJKL`, derived from the two keys (CT-CRYPTO). */
  fingerprint: string;
  last_seen_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: CreatedAt;
}

/** `workspaces`: a team's space; soft-deleted through `deleted_at`. */
export interface WorkspacesTable {
  /** `wsp_` id. */
  id: FixedId;
  /** 1-60 characters. */
  name: string;
  /** `[a-z0-9-]{3,40}`, unique (also among deleted workspaces). */
  slug: string;
  /** CT-API-WORKSPACES `WorkspaceSettings`; default `{}`. */
  settings: ColumnType<JsonObject, JsonObject | undefined, JsonObject>;
  /** The ETag; incremented on every change. */
  version: Generated<number>;
  created_by: FixedId;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: NullableTimestamp;
}

/** `memberships`: a user's role in a workspace; one per (workspace, user). */
export interface MembershipsTable {
  /** `mem_` id. */
  id: FixedId;
  workspace_id: FixedId;
  user_id: FixedId;
  role: Api.Role;
  created_at: CreatedAt;
}

/** `sessions`: command posts (metadata only; their content never reaches the backend). */
export interface SessionsTable {
  /** `ses_` id. */
  id: FixedId;
  workspace_id: ColumnType<string | null, string | null | undefined, never>;
  /** 1-80 characters. */
  name: string;
  state: Generated<Api.Session['state']>;
  /** Relay region, such as `eu`. */
  region: string;
  created_by: FixedId;
  created_at: CreatedAt;
  ended_at: NullableTimestamp;
}

/** `session_members`: who joined a session on which device, in which slot. */
export interface SessionMembersTable {
  /** `mem_` id. */
  id: FixedId;
  session_id: FixedId;
  user_id: FixedId;
  device_id: FixedId;
  role: Api.SessionRole;
  /** 0 or more; unique within the session. */
  slot: number;
  joined_at: CreatedAt;
  left_at: NullableTimestamp;
}

/** The core tables, for `createDb<CoreDatabase>()`. */
export interface CoreDatabase {
  users: UsersTable;
  devices: DevicesTable;
  workspaces: WorkspacesTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  session_members: SessionMembersTable;
}
