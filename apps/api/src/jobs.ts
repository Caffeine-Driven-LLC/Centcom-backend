/**
 * The worker's jobs over the API's services (B109): the usage aggregation that fills the monthly
 * counters, the session and invite expiry sweeps and the workspace purge with its hooks. The
 * process that runs them is `worker.ts`; the queues, schedules and retries are @centcom/worker's.
 *
 * Owns: wiring the jobs to the services. Must not: open connections or read the environment.
 */
import {
  createPurgeHookRegistry,
  HISTORY_PURGE_HOOK,
  registerEntitlementsPurgeHook,
  registerHistoryPurgeHook,
  registerInvitePurgeHook,
  registerProjectPurgeHook,
  registerWorkspaceSettingsPurgeHook,
  type PurgeHookRegistry,
} from '@centcom/worker';
import {
  createInviteStore,
  createProjectStore,
  createWorkspaceSettingsStore,
  createWorkspaceStore,
  type CoreDatabase,
  type InviteDatabase,
  type HistoryDatabase,
  type ProjectDatabase,
  type WorkspaceSettingsDb,
} from '@centcom/db';
import {
  createHistoryStore,
  createS3BlobStore,
  createWorkspaceHistoryPurger,
} from '@centcom/storage';
import type { Kysely } from 'kysely';
import type { AppContext } from './context.js';
import {
  blobTombstoneLog,
  registerTombstoneHook,
  type TombstoneLog,
} from './modules/tombstones/index.js';
import {
  AccountExportRunner,
  duePurges,
  purgeUser,
  workspaceDeleterFrom,
  type PurgeDb,
  type PurgeOutcome,
} from './modules/account-lifecycle/index.js';
import { createEntitlementRepository } from './modules/entitlements/repository.js';
import { UsageAggregator } from './modules/usage/aggregate.js';
import { subscribedPeriod } from './modules/usage/quota.js';

/** What the jobs run over. */
export interface JobServices {
  usage: UsageAggregator;
  sessions: { sweep(now: Date): Promise<{ paused: number; expired: number }> } | null;
  shareLinks: { sweep(now: Date): Promise<number> } | null;
  invites: { sweep(now: Date): Promise<{ expired: number; bundlesDropped: number }> };
  /** Hard-deletes a deleted workspace. */
  workspaces: { purge(workspaceId: string): Promise<{ purged: boolean }> };
  hooks: PurgeHookRegistry;
  /** The deletion tombstone log; null without an object store. */
  tombstones: TombstoneLog | null;
  /** The account lifecycle's jobs (B026). */
  accounts: {
    /** `purgeUser` over the live services; writes the account's tombstone first when there is a log. */
    purge(userId: string): Promise<PurgeOutcome>;
    /** Users whose deletion deadline has passed (the hourly sweep's input). */
    due(now: Date, limit: number): Promise<string[]>;
    /** Builds and expires exports; null without an object store. */
    exports: AccountExportRunner | null;
  };
}

/** Builds the job services from the API's context. */
export function createJobServices(ctx: AppContext): JobServices {
  const db = ctx.db as unknown as Kysely<CoreDatabase>;
  const view = <DB>(): Kysely<DB> => ctx.db as unknown as Kysely<DB>;
  const hooks = createPurgeHookRegistry();
  // First hook: the tombstone is written before any data is destroyed (see modules/tombstones).
  const tombstones =
    ctx.config.objectStore === null
      ? null
      : blobTombstoneLog(createS3BlobStore(ctx.config.objectStore));
  if (tombstones !== null) registerTombstoneHook(hooks, tombstones);
  const invites = createInviteStore(view<InviteDatabase>());
  registerInvitePurgeHook(hooks, invites);
  registerEntitlementsPurgeHook(hooks, createEntitlementRepository(view()));
  registerProjectPurgeHook(hooks, createProjectStore(view<ProjectDatabase>()));
  registerWorkspaceSettingsPurgeHook(
    hooks,
    createWorkspaceSettingsStore(view<WorkspaceSettingsDb>()),
  );
  if (ctx.config.objectStore !== null) {
    registerHistoryPurgeHook(
      hooks,
      createWorkspaceHistoryPurger({
        db: view<HistoryDatabase>(),
        store: createHistoryStore({
          db: view<HistoryDatabase>(),
          blobs: createS3BlobStore(ctx.config.objectStore),
        }),
      }),
    );
  } else {
    ctx.logger.info({ hook: HISTORY_PURGE_HOOK }, 'worker.purge_hook_skipped');
  }
  return {
    usage: new UsageAggregator({
      counters: ctx.counters,
      periods: {
        period: async (workspaceId) =>
          subscribedPeriod((await ctx.entitlementService.get(workspaceId))?.period),
      },
      quota: ctx.quota,
      clock: ctx.clock ?? Date.now,
      logger: ctx.logger,
      metrics: ctx.metrics,
    }),
    sessions: ctx.sessionService,
    shareLinks: ctx.collab.shareLinks,
    invites,
    workspaces: createWorkspaceStore(db),
    hooks,
    tombstones,
    accounts: {
      purge: (userId) =>
        purgeUser(
          {
            db: view<PurgeDb>(),
            blobs: ctx.accounts.blobs ?? { delete: () => Promise.resolve() },
            deleteWorkspace: workspaceDeleterFrom(ctx.collab.workspaces, ctx.accounts.emitter),
            emitter: ctx.accounts.emitter,
            ...(tombstones === null ? {} : { tombstones }),
            clock: ctx.clock ?? Date.now,
            logger: ctx.logger,
            metrics: ctx.metrics,
          },
          userId,
        ),
      due: (now, limit) => duePurges(view<PurgeDb>(), now, limit),
      exports:
        ctx.accounts.blobs === null
          ? null
          : new AccountExportRunner({
              store: ctx.accounts.store,
              blobs: ctx.accounts.blobs,
              clock: ctx.clock ?? Date.now,
              logger: ctx.logger,
              metrics: ctx.metrics,
            }),
    },
  };
}
