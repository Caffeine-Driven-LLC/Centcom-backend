/**
 * @centcom/db (B007): the Postgres client (Kysely over `pg`), the forward-only migration runner,
 * transactions with serialization retry, and the health probe for `/readyz`. The `centcom-db` CLI
 * (`src/cli.ts`) runs migrations as a deploy step. Conventions for schema work:
 * packages/db/CONVENTIONS.md. Table types: the core schema (B008) in `schema/core.ts`, social-login
 * identities (B015) in `schema/identities.ts`, refresh tokens (B017) in
 * `schema/refresh-tokens.ts`, e-mail sign-in links (B014) in
 * `schema/login-tokens.ts`, the audit log (B036) in `schema/audit-events.ts` and its export jobs
 * (B082) in `schema/audit-exports.ts`, invites (B029) in
 * `schema/invites.ts`, device grants (B016) in `schema/device-grants.ts`, API keys (B019) in
 * `schema/api-keys.ts`, workspace settings (B034) in `schema/workspace-settings.ts`, projects
 * (B035) in `schema/projects.ts`, member slots (B031) in `schema/session-slots.ts`, notifications
 * (B063) in `schema/notifications.ts`, plans and entitlements (B069) in `schema/entitlements.ts`,
 * feature flags (B083) in `schema/feature-flags.ts`, release manifests (B084) in
 * `schema/releases.ts`, telemetry (B085) in `schema/telemetry.ts`, the status feed (B086) in
 * `schema/status.ts`, staff access (B087) in `schema/staff.ts`, account deletion and data
 * exports (B026) in `schema/account-lifecycle.ts`, Stripe webhook events and the billing outbox
 * (B072) in `schema/stripe-events.ts`, the durable history index (B055) in `schema/history.ts`,
 * session policy and mutes (B051) in `schema/control.ts`, the command-post queue (B052) in
 * `schema/queue.ts`, the session lifecycle (B053) in `schema/sessions-lifecycle.ts`, dunning
 * (B078) in `schema/dunning.ts`, retention's run reports and bookkeeping (B090) in
 * `schema/retention.ts`; repositories (B013 on, devices
 * from B020, workspaces from B027, members from B028, invites from B029, settings from B034,
 * projects from B035, slots from B031, notifications from B063, retention from B090) in
 * `repos/`; the entitlements
 * repository is the API's (B069).
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
  createDeviceRepo,
  DEVICE_COLUMNS,
  DEVICE_LIST_SORTS,
  type DeviceRecord,
  type DeviceRepo,
  type NewDevice,
} from './repos/devices.js';
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
  createProjectStore,
  PROJECT_LIST_SORTS,
  projectOperations,
  PROJECTS_NAME_KEY,
  type NewProject,
  type ProjectChanges,
  type ProjectRecord,
  type ProjectStore,
  type ProjectTx,
} from './repos/projects.js';
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
export {
  createRetentionRepository,
  type RetentionPendingRecord,
  type RetentionRepository,
  type RetentionRowPolicyId,
  type RetentionRowStore,
} from './repos/retention.js';
export type {
  ApiKeyDatabase,
  ApiKeyMode,
  ApiKeysDatabase,
  ApiKeysTable,
} from './schema/api-keys.js';
export type {
  AccountExportStatus,
  AccountExportsTable,
  AccountLifecycleDatabase,
  LifecycleUsersTable,
} from './schema/account-lifecycle.js';
export type { AuditDatabase, AuditEventsTable } from './schema/audit-events.js';
export type {
  ControlDatabase,
  ControlTables,
  SessionMuteTable,
  SessionPolicyTable,
} from './schema/control.js';
export type { AgentsDatabase, AgentTable, AgentTables } from './schema/agents.js';
export type {
  QueueDatabase,
  QueueItemTable,
  QueueSessionTable,
  QueueTables,
} from './schema/queue.js';
export type {
  LifecycleSessionsTable,
  SessionOutboxTable,
  SessionsLifecycleDatabase,
  SessionsLifecycleTables,
} from './schema/sessions-lifecycle.js';
export type {
  RetentionAbortReason,
  RetentionBaselineTable,
  RetentionDataset,
  RetentionDb,
  RetentionPendingTable,
  RetentionRunsTable,
  RetentionTables,
} from './schema/retention.js';
export type {
  HistoryDatabase,
  HistoryIndexTable,
  HistoryRetentionTable,
  HistoryTables,
} from './schema/history.js';
export type {
  BillingOutboxTable,
  StripeEventStatus,
  StripeEventsDatabase,
  StripeEventTable,
} from './schema/stripe-events.js';
export type {
  AuditApiDb,
  AuditExportDatabase,
  AuditExportJobsTable,
  AuditExportStatus,
} from './schema/audit-exports.js';
export type {
  FeatureFlagsMetaTable,
  FeatureFlagsTable,
  FlagDatabase,
  FlagType,
} from './schema/feature-flags.js';
export type {
  ReleaseArtifactsTable,
  ReleaseChannel,
  ReleaseDatabase,
  ReleasesTable,
} from './schema/releases.js';
export type {
  TelemetryDailyAggTable,
  TelemetryDatabase,
  TelemetryEventsTable,
  TelemetryRollupsTable,
} from './schema/telemetry.js';
export type {
  IncidentStatus,
  StatusDatabase,
  StatusDeprecationsTable,
  StatusIncidentsTable,
  StatusIncidentUpdatesTable,
} from './schema/status.js';
export type {
  AdminDatabase,
  StaffAuditDetailsTable,
  StaffRole,
  StaffUsersColumns,
  StaffUsersTable,
} from './schema/staff.js';
export type {
  DeviceGrantDatabase,
  DeviceGrantsDatabase,
  DeviceGrantStatus,
  DeviceGrantsTable,
  DevicePlatform,
} from './schema/device-grants.js';
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
export type { ProjectDatabase, ProjectsDatabase, ProjectsTable } from './schema/projects.js';
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
  PushDatabase,
  PushSubscriptionsDatabase,
  PushSubscriptionsTable,
  SealedColumn,
} from './schema/push-subscriptions.js';
export type {
  NotificationPrefDatabase,
  NotificationPrefDb,
  NotificationPrefTable,
} from './schema/notification-preferences.js';
export type {
  BillingCustomerTable,
  BillingDatabase,
  BillingDb,
  BillingSubscriptionTable,
} from './schema/billing.js';
export type {
  DunningDatabase,
  DunningDb,
  DunningNoneReason,
  DunningStatus,
  SubscriptionDunningTable,
} from './schema/dunning.js';
export type {
  InvoiceMirrorStatus,
  InvoicesDatabase,
  InvoicesDb,
  InvoicesTable,
  InvoiceSyncsTable,
  InvoiceTaxLine,
} from './schema/invoices.js';
export type {
  BillingTrialOwnersTable,
  BillingTrialsTable,
  CouponRedemptionsTable,
  PromotionsDatabase,
  PromotionsDb,
} from './schema/promotions.js';
export type {
  QuotaSignalsDatabase,
  QuotaSignalsDb,
  QuotaSignalStateTable,
} from './schema/quota-signals.js';
export type {
  QuotaStateTable,
  UsageAggregateCursorTable,
  UsageAggregationDatabase,
  UsageAggregationDb,
  UsageCounterTable,
  UsageDatabase,
  UsageDb,
  UsageEventTable,
} from './schema/usage.js';
export type {
  WebhookDatabase,
  WebhookDb,
  WebhookDeliveriesTable,
  WebhookEndpointsTable,
  WebhookEventsTable,
  WebhookOutboxTable,
} from './schema/webhooks.js';
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
