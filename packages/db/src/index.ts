/**
 * @centcom/db (B007): the Postgres client (Kysely over `pg`), the forward-only migration runner,
 * transactions with serialization retry, and the health probe for `/readyz`. The `centcom-db` CLI
 * (`src/cli.ts`) runs migrations as a deploy step. Conventions for schema work:
 * packages/db/CONVENTIONS.md. Table types: the core schema (B008) in `schema/core.ts`, social-login
 * identities (B015) in `schema/identities.ts`; repositories (B013 on) in `repos/`.
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
  createUserRepo,
  isEmailTaken,
  USER_COLUMNS,
  USERS_EMAIL_KEY,
  type NewUser,
  type ProfilePatch,
  type User,
  type UserRepo,
} from './repos/users.js';
export type {
  IdentitiesDatabase,
  IdentitiesTable,
  IdentityProvider,
  SocialDatabase,
} from './schema/identities.js';
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
