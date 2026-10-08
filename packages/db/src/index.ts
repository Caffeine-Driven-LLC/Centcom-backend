/**
 * @centcom/db (B007): the Postgres client (Kysely over `pg`), the forward-only migration runner,
 * transactions with serialization retry, and the health probe for `/readyz`. The `centcom-db` CLI
 * (`src/cli.ts`) runs migrations as a deploy step. Conventions for schema work:
 * packages/db/CONVENTIONS.md. Table types: the core schema (B008) in `schema/core.ts`, social-login
 * identities (B015) in `schema/identities.ts`, refresh tokens (B017) in
 * `schema/refresh-tokens.ts`, e-mail sign-in links (B014) in
 * `schema/login-tokens.ts`, the audit log (B036) in `schema/audit-events.ts`, invites (B029) in
 * `schema/invites.ts`, workspace settings (B034) in `schema/workspace-settings.ts`, notifications
 * (B063) in `schema/notifications.ts`, member slots (B031) in `schema/session-slots.ts`, plans
 * and entitlements (B069) in `schema/entitlements.ts`; repositories (B013 on, workspaces from
 * B027, members from B028, invites from B029, settings from B034, notifications from B063, slots
 * from B031) in `repos/`; the entitlements repository is the API's (B069).
 */
export {
  ACQUIRE_BUCKETS_S,
  closeDb,
  createDb,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  isConnectionError,
  poolStats,
  type Database,
  type DbConfig,
  type PoolStats,
  type SchemaMigrationsTable,
} from './client.js';
export {
  currentMigrationVersion,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  lintMigration,
  migrate,
  migrationChecksum,
  MigrationError,
  migrationStatus,
  MIGRATION_FILE_PATTERN,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_NAME,
  MIGRATIONS_DIR,
  parseMigrationFileName,
  readMigrations,
  type AppliedMigration,
  type MigrateOptions,
  type MigrationErrorCode,
  type MigrationFile,
  type MigrationStatus,
} from './migrate.js';
export {
  isSerializationFailure,
  MAX_SERIALIZATION_RETRIES,
  SERIALIZATION_FAILURE,
  withTransaction,
  type IsolationLevel,
  type TransactionOptions,
} from './tx.js';
export {
  DEFAULT_HEALTH_TIMEOUT_MS,
  expectedMigrationVersion,
  healthCheck,
  type HealthOptions,
  type HealthReport,
} from './health.js';
export { createMembershipRepo } from './repos/memberships.js';
export {
  createSessionSlotStore,
  SLOT_STATEMENT_TIMEOUT_MS,
  type SessionSlotStore,
  type SlotAssignment,
} from './repos/session-slots.js';
export {
  createInviteStore,
  INVITE_LIST_SORTS,
  inviteOperations,
  inviteStatus,
  type InvitePreviewRow,
  type InviteRecord,
  type InviteRole,
  type InviteStatus,
  type InviteStore,
  type InviteTx,
  type NewInvite,
} from './repos/invites.js';
export {
  createMemberStore,
  MEMBER_LIST_SORTS,
  memberOperations,
  type MemberRecord,
  type MemberStore,
  type MemberTx,
  type NewMember,
} from './repos/members.js';
export {
  createWorkspaceStore,
  PURGE_AUDIT_BATCH,
  WORKSPACE_LIST_SORTS,
  type NewWorkspace,
  type WorkspaceRecord,
  type WorkspaceStore,
  type WorkspaceTx,
  type WorkspaceView,
} from './repos/workspaces.js';
export {
  createWorkspaceSettingsStore,
  type WorkspaceSettingsRecord,
  type WorkspaceSettingsStore,
  type WorkspaceSettingsTx,
  type WorkspaceSettingsValues,
} from './repos/workspace-settings.js';
export {
  createNotificationStore,
  type NewNotification,
  type NotificationInsert,
  type NotificationRecord,
  type NotificationStore,
} from './repos/notifications.js';
export {
  createUserRepo,
  isEmailTaken,
  USER_COLUMNS,
  USERS_EMAIL_KEY,
  type NewUser,
  type ProfilePatch,
  type User,
  type UserRepo,
} from './repos/users.js';
export type { AuditDatabase, AuditEventsTable } from './schema/audit-events.js';
export type {
  SessionMemberSlotsTable,
  SessionSlotDatabase,
  SessionSlotsDatabase,
} from './schema/session-slots.js';
export type {
  EntitlementsDatabase,
  EntitlementsDb,
  EntitlementStatus,
  LimitKey,
  PlanId,
  PlanLimitsTable,
  PlansTable,
  WorkspaceEntitlementsTable,
} from './schema/entitlements.js';
export type { InviteDatabase, InvitesDatabase, InvitesTable } from './schema/invites.js';
export type {
  AutoApprove,
  WorkspaceSettingsDatabase,
  WorkspaceSettingsDb,
  WorkspaceSettingsTable,
} from './schema/workspace-settings.js';
export type {
  NotificationDb,
  NotificationsDatabase,
  NotificationsTable,
} from './schema/notifications.js';
export type {
  IdentitiesDatabase,
  IdentitiesTable,
  IdentityProvider,
  SocialDatabase,
} from './schema/identities.js';
export type {
  LoginTokensDatabase,
  LoginTokensTable,
  MagicLinkDatabase,
} from './schema/login-tokens.js';
export type {
  ClientId,
  RefreshTokensDatabase,
  RefreshTokensTable,
  TokenDatabase,
} from './schema/refresh-tokens.js';
export type {
  CoreDatabase,
  CreatedAt,
  DevicesTable,
  FixedId,
  JsonObject,
  MembershipsTable,
  NullableTimestamp,
  SessionMembersTable,
  SessionsTable,
  UpdatedAt,
  UsersTable,
  UserStatus,
  WorkspacesTable,
} from './schema/core.js';
