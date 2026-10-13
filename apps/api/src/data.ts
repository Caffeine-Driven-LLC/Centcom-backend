/**
 * The services of what a session leaves behind and what a workspace uses (B107): history and
 * snapshots (over the S3-compatible object store), usage reports and summaries, and notification
 * preferences. Their routes are listed in `modules.ts`.
 *
 * Owns: constructing these lanes' services. Must not: register routes, or read the environment.
 */
import {
  type AuditDb,
  type AuditEmitter,
  createAuditEmitter,
  type Logger,
  type Metrics,
  type RedisBackend,
} from '@centcom/core';
import type { CoreDatabase, HistoryDatabase, NotificationPrefDb, UsageDb } from '@centcom/db';
import { createHistoryStore, createS3BlobStore } from '@centcom/storage';
import type { Kysely } from 'kysely';
import type { ApiConfig } from './config.js';
import type { ApiDatabase } from './context.js';
import {
  createPostgresHistoryAccess,
  HistoryService,
  type AccessDatabase,
} from './modules/history/index.js';
import { PreferencesService } from './modules/notifications/preferences/service.js';
import { createPreferencesRepository } from './modules/notifications/preferences/repository.js';
import { SeatService } from './modules/seats/index.js';
import { createS3SnapshotObjects } from './modules/snapshots/presign.js';
import { createSnapshotRepository, type SnapshotsDb } from './modules/snapshots/repository.js';
import { SNAPSHOT_AUDIT_ACTIONS, SnapshotService } from './modules/snapshots/service.js';
import { createCounterStore } from './modules/usage/counters.js';
import { UsageIngest } from './modules/usage/ingest.js';
import { createUsageRepository } from './modules/usage/repository.js';
import { QuotaService } from './modules/usage/quota.js';
import { UsageSummaryService } from './modules/usage/reader.js';
import type { EntitlementService } from './modules/entitlements/service.js';

/** The bucket snapshots live in (history has `OBJECT_STORE_BUCKET`). */
export const SNAPSHOT_BUCKET = 'snapshots';

/** What the services are built from. */
export interface DataDeps {
  config: ApiConfig;
  db: Kysely<ApiDatabase>;
  redis: RedisBackend;
  logger: Logger;
  metrics: Metrics;
  clock: () => number;
  audit: AuditEmitter;
  entitlementService: EntitlementService;
  counters: ReturnType<typeof createCounterStore>;
  quota: QuotaService;
}

/** The services; each is null when what it needs is not configured. */
export interface Data {
  /** Null without an object store. */
  history: HistoryService | null;
  /** Null without an object store. */
  snapshots: SnapshotService | null;
  usageIngest: UsageIngest;
  usageSummary: UsageSummaryService;
  preferences: PreferencesService;
}

export function createData(deps: DataDeps): Data {
  const { config, db, redis, logger, metrics, clock, audit } = deps;
  const view = <DB>(): Kysely<DB> => db as unknown as Kysely<DB>;
  const store = config.objectStore;

  const history =
    store === null
      ? null
      : new HistoryService({
          store: createHistoryStore({
            db: view<HistoryDatabase>(),
            blobs: createS3BlobStore(store),
          }),
          access: createPostgresHistoryAccess(view<AccessDatabase & CoreDatabase>()),
          audit,
          logger,
          metrics,
        });
  const snapshots =
    store === null
      ? null
      : new SnapshotService({
          rows: createSnapshotRepository(view<SnapshotsDb>()),
          objects: createS3SnapshotObjects({ ...store, bucket: SNAPSHOT_BUCKET }),
          access: createPostgresHistoryAccess(view<AccessDatabase & CoreDatabase>()),
          // `snapshot.*` is not in CT-API-AUDIT's list: this module's emitter has its own.
          audit: createAuditEmitter({
            db: view<CoreDatabase>() as unknown as AuditDb,
            logger,
            metrics,
            actions: SNAPSHOT_AUDIT_ACTIONS,
          }),
          clock,
          logger,
          metrics,
        });
  const seats = new SeatService({ db, now: clock });
  return {
    history,
    snapshots,
    usageIngest: new UsageIngest({
      repository: createUsageRepository(view<UsageDb>()),
      kv: redis.kv,
      pubsub: redis.pubsub,
      clock,
      logger,
      metrics,
    }),
    usageSummary: new UsageSummaryService({
      counters: deps.counters,
      quota: deps.quota,
      seats: { usage: (workspaceId) => seats.usage(workspaceId) },
      entitlements: deps.entitlementService,
      clock,
    }),
    preferences: new PreferencesService({
      repository: createPreferencesRepository(view<NotificationPrefDb>()),
      clock,
      logger,
    }),
  };
}
