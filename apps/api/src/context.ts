/**
 * The services of the API process (B102): built once from the configuration and the open
 * connections, then handed to the route modules. Tests build the same thing over in-memory or
 * test-container backends, so nothing here reads `process.env` or opens a connection.
 *
 * Owns: constructing each lane's service with its dependencies, and registering the grant
 * handlers with the token service. Must not: start listening, or register routes (that is
 * `app.ts` and `modules.ts`).
 */
import { createIdGenerator } from '@centcom/contracts';
import {
  type AuditDb,
  type Authorizer as RbacAuthorizer,
  type EmailQueue,
  type Logger,
  type Metrics,
  type RedisBackend,
  cachedMembershipReader,
  createAuditEmitter,
  createAuthorizer,
  createEmailService,
  noopMetrics,
  rbacAuditSink,
  secretGuard,
  RELAY_CONTROL_CHANNEL,
} from '@centcom/core';
import {
  createMembershipRepo,
  createSessionSlotStore,
  type EntitlementsDatabase,
  type SessionSlotDatabase,
  type CoreDatabase,
  type DeviceGrantDatabase,
  type MagicLinkDatabase,
  type StatusDatabase,
  type TokenDatabase,
} from '@centcom/db';
import type { Kysely } from 'kysely';
import type { ApiConfig } from './config.js';
import { DeviceGrantService } from './modules/auth/device/service.js';
import { createDeviceGrantStore } from './modules/auth/device/store.js';
import { registerDeviceGrant } from './modules/auth/device/grant-handler.js';
import { MagicLinkService } from './modules/auth/magic-link/service.js';
import { createLoginTokenStore } from './modules/auth/magic-link/store.js';
import { emailMagicLinkMailer, type MagicLinkMailer } from './modules/auth/magic-link/mailer.js';
import { Authorizer } from './modules/auth/pkce/authorize.js';
import { AuthorizationCodeStore } from './modules/auth/pkce/code-store.js';
import { registerAuthorizationCodeGrant } from './modules/auth/pkce/grant-handler.js';
import { returnToPolicy } from './modules/auth/return-to.js';
import { TokenService } from './modules/auth/tokens/index.js';
import { createLoginSessions, type LoginSessions } from './modules/auth/web-session/store.js';
import { deviceStoreFromDb } from './modules/devices/repo.js';
import { DeviceService } from './modules/devices/service.js';
import {
  ACCOUNT_LIFECYCLE_ACTIONS,
  AccountLifecycleService,
  createAccountLifecycleStore,
  exportBlobStoreFrom,
  type AccountJobs,
  type AccountLifecycleAction,
  type AccountLifecycleStore,
  type ExportBlobStore,
  type LifecycleDb,
} from './modules/account-lifecycle/index.js';
import { createS3ObjectStore } from './modules/audit-api/object-store.js';
import { createCollab, type Collab } from './collab.js';
import { createBilling, type Billing } from './billing.js';
import type { EventQueue as StripeEventQueue } from './modules/billing/webhooks/ingest.js';
import { CachedEntitlements } from './modules/entitlements/enforcement.js';
import type { UsageAggregationDb } from '@centcom/db';
import { createData, type Data } from './data.js';
import type { PurgeQueue } from './modules/workspaces/service.js';
import { createCounterStore } from './modules/usage/counters.js';
import { QuotaService } from './modules/usage/quota.js';
import { createUsageReader } from './modules/usage/reader.js';
import { pubsubQuotaEvents } from './modules/usage/quota.js';
import { createEntitlementRepository } from './modules/entitlements/repository.js';
import { EntitlementService } from './modules/entitlements/service.js';
import { SessionService, createSessionRepository } from './modules/sessions/index.js';
import type { SessionsDb } from './modules/sessions/index.js';
import { createSessionRouteStore } from './routes/sessions/index.js';
import type { SessionRouteDeps, SessionRoutesDb } from './routes/sessions/index.js';
import { createAccountStore, MeService } from './modules/me/service.js';
import { Readiness } from './modules/status/readiness.js';
import { ComponentProber } from './modules/status/prober.js';
import { createStatusRepository } from './modules/status/repository.js';
import { StatusFeed } from './modules/status/service.js';
import { UserService } from './modules/users/index.js';

/** The tables the services of this process read and write. */
export type ApiDatabase = CoreDatabase & TokenDatabase & DeviceGrantDatabase;

/** What `buildApp` is given. */
export interface AppDeps {
  config: ApiConfig;
  db: Kysely<ApiDatabase>;
  redis: RedisBackend;
  logger: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** Sends sign-in links; without one, e-mail sign-in is off. */
  mailer?: MagicLinkMailer;
  /**
   * The worker's `email-send` queue (production mail). With one, sign-in links and invites are
   * queued through B032's email service and the worker delivers them with the configured provider.
   */
  emailQueue?: EmailQueue;
  /** Where Stripe webhook events are queued for the worker; without one the worker's sweep finds them. */
  stripeEventQueue?: StripeEventQueue;
  /** Where a deleted workspace's purge is queued (the worker's `workspace-purge` queue); without one it is only logged. */
  purgeQueue?: PurgeQueue;
  /**
   * The worker's `account-export` and `account-purge` queues. Without them nothing is queued at request
   * time: the worker's sweeps (hourly for purges, every 15 minutes for exports) find the work instead.
   */
  accountJobs?: AccountJobs;
}

/** The account lifecycle's services (B026). */
export interface AccountLifecycle {
  service: AccountLifecycleService;
  store: AccountLifecycleStore;
  /** Where export files go; null without an object store (exports are then not offered). */
  blobs: ExportBlobStore | null;
  /** Writes `account.*` audit events (also used by the worker's purge). */
  emitter: ReturnType<typeof createAuditEmitter<AccountLifecycleAction>>;
}

/** The services the route modules draw on. */
export interface AppContext extends AppDeps {
  metrics: Metrics;
  tokens: TokenService;
  sessions: LoginSessions;
  deviceGrants: DeviceGrantService;
  authorizer: Authorizer;
  users: UserService;
  /** Null when e-mail sign-in is off. */
  magicLink: MagicLinkService | null;
  /** The URL e-mail sign-in returns to for the device pages; null when e-mail sign-in is off. */
  deviceReturnTo: string | null;
  me: MeService;
  devices: DeviceService;
  readiness: Readiness<ApiDatabase>;
  statusFeed: StatusFeed;
  /** Role checks for the routes that guard by workspace or session role. */
  rbac: RbacAuthorizer;
  /** Writes audit events; flush it on shutdown. */
  audit: ReturnType<typeof createAuditEmitter>;
  /** The session routes' dependencies; null when no relay address is configured. */
  sessionRoutes: SessionRouteDeps | null;
  /** The session lifecycle service (the worker's expiry sweep); null with the session routes. */
  sessionService: SessionService | null;
  /** Workspaces, members, invites, share links and seats. */
  collab: Collab;
  /** Stripe billing; null when STRIPE_SECRET_KEY is not set. */
  billing: Billing | null;
  /** Account deletion and data export (B026). */
  accounts: AccountLifecycle;
  /** What each workspace's plan allows, cached. */
  entitlements: CachedEntitlements;
  /** The plan catalogue and the uncached reads (B069). */
  entitlementService: EntitlementService;
  /** History, snapshots, usage and notification preferences (B107). */
  data: Data;
  /** The monthly usage counters and the quotas over them (read by the entitlement check, filled by the worker). */
  counters: ReturnType<typeof createCounterStore>;
  quota: QuotaService;
}

const newId = createIdGenerator();

/** Where the device pages are, absolute. */
export const deviceUrl = (publicApiUrl: string): string =>
  `${publicApiUrl.replace(/\/+$/, '')}/device`;

export function createContext(deps: AppDeps): AppContext {
  const { config, db, redis } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  // B101 surface 1: every line the services write passes the scanner first; a provider credential
  // becomes `[redacted:<pattern>]` and is counted. The worker and the scripts get it too (createContext).
  const logger = secretGuard.createGuardedLogger(deps.logger, { metrics });
  const clock = deps.clock ?? Date.now;
  const kv = redis.kv;

  // Production mail: queued through B032's service, delivered by the worker's email-send job.
  const emailService =
    deps.emailQueue !== undefined && config.email !== null
      ? createEmailService({
          queue: deps.emailQueue,
          rateLimit: redis.rateLimit,
          kv: redis.kv,
          from: config.email.from,
          logger,
          metrics,
        })
      : null;
  const mailer: MagicLinkMailer | undefined =
    deps.mailer ??
    (emailService !== null && config.magicLink !== null
      ? emailMagicLinkMailer(emailService, config.magicLink.ttlS)
      : undefined);

  // Each lane types its tables narrowly; Kysely is invariant in them, so the wiring narrows here.
  const view = <DB>(): Kysely<DB> => db as unknown as Kysely<DB>;

  const tokens = new TokenService({
    db: view<TokenDatabase>(),
    keys: config.keys,
    kv,
    now: clock,
    logger,
    metrics,
  });
  const grantStore = createDeviceGrantStore(view<DeviceGrantDatabase>());
  registerDeviceGrant(tokens, grantStore, clock);
  const codes = new AuthorizationCodeStore({ kv });
  registerAuthorizationCodeGrant({ tokens, codes, now: clock, logger });

  const sessions = createLoginSessions({ kv, now: clock });
  const deviceGrants = new DeviceGrantService({
    store: grantStore,
    kv,
    now: clock,
    ...(config.verificationUri === null ? {} : { verificationUri: config.verificationUri }),
    logger,
  });
  const authorizer = new Authorizer({
    codes,
    redirects: config.pkce.redirects,
    loginUrl: config.pkce.loginUrl,
    keys: config.keys,
    now: clock,
  });
  const devPlan = config.devDefaultPlan ?? config.selfHostPlan;
  const users = new UserService({
    db: view<CoreDatabase>(),
    newId,
    now: () => new Date(clock()),
    // Development or self-hosting without Stripe: a new personal workspace starts on a paid plan
    // (see DEV_DEFAULT_PLAN and SELF_HOST_PLAN).
    ...(devPlan === null || devPlan === 'free'
      ? {}
      : {
          onCreated: async (trx, { workspaceId }) => {
            await (trx as unknown as Kysely<EntitlementsDatabase>)
              .insertInto('workspace_entitlements')
              .values({ workspace_id: workspaceId, plan_id: devPlan, status: 'active' })
              .onConflict((oc) =>
                oc.column('workspace_id').doUpdateSet({ plan_id: devPlan, status: 'active' }),
              )
              .execute();
          },
        }),
  });

  const login = config.magicLink;
  const deviceReturnTo = login !== null && mailer !== undefined ? deviceUrl(login.baseUrl) : null;
  const magicLink =
    login !== null && mailer !== undefined && deviceReturnTo !== null
      ? new MagicLinkService({
          store: createLoginTokenStore(view<MagicLinkDatabase>()),
          mailer,
          users,
          rateLimit: redis.rateLimit,
          // The device pages are a fixed place to come back to; everything else is the allow-list.
          returnTo: returnToPolicy([...login.returnToAllowlist, deviceReturnTo]),
          baseUrl: login.baseUrl,
          ttlS: login.ttlS,
          clock,
          logger,
          metrics,
        })
      : null;

  const me = new MeService({
    store: createAccountStore(view<CoreDatabase>()),
    audit: {
      record: (event) => {
        logger.info({ action: event.action, user_id: event.userId }, 'account.updated');
        return Promise.resolve();
      },
    },
    logger,
    metrics,
    now: clock,
  });
  const devices = new DeviceService({
    store: deviceStoreFromDb(view<CoreDatabase>()),
    tokens,
    pubsub: redis.pubsub,
    logger,
    metrics,
    now: clock,
  });

  const readiness = new Readiness<ApiDatabase>({
    db,
    redis,
    expectedVersion: config.status.expectedMigrationVersion,
    timeoutMs: config.status.readyzTimeoutMs,
  });
  const statusFeed = new StatusFeed({
    prober: new ComponentProber({ components: config.status.components, kv, metrics }),
    repository: createStatusRepository(view<StatusDatabase>()),
    kv,
    components: config.status.components,
    minClientVersion: config.status.minClientVersion,
    clock,
    logger,
    metrics,
  });

  const audit = createAuditEmitter({
    db: view<CoreDatabase>() as unknown as AuditDb,
    logger,
    metrics,
  });
  const rbac = createAuthorizer({
    memberships: cachedMembershipReader(createMembershipRepo(view<CoreDatabase>()), {
      now: clock,
    }),
    audit: rbacAuditSink(audit),
    logger,
    metrics,
    now: clock,
  });

  const counters = createCounterStore(view<UsageAggregationDb>());
  const entitlementService = new EntitlementService({
    repository: createEntitlementRepository(view()),
    events: redis.pubsub,
    usage: createUsageReader(counters, clock),
    clock,
    logger,
    metrics,
  });
  // Devices report usage (POST /v1/usage); the worker's aggregation job turns the reports into the
  // counters this reads, so a metered limit (queue items, hosted minutes) is enforced from them.
  const quota = new QuotaService({
    counters,
    entitlements: entitlementService,
    rev: entitlementService,
    events: pubsubQuotaEvents(redis.pubsub),
    clock,
    logger,
    metrics,
  });
  const entitlements = new CachedEntitlements({
    source: entitlementService,
    quota,
    pubsub: redis.pubsub,
    clock,
    logger,
    metrics,
  });

  let sessionRoutes: SessionRouteDeps | null = null;
  let sessionService: SessionService | null = null;
  if (config.relay !== null) {
    const regions = {
      defaultRegion: config.relay.region,
      urls: { [config.relay.region]: config.relay.url },
    };
    sessionService = new SessionService({
      repository: createSessionRepository(db as unknown as SessionsDb),
      entitlements,
      // The relay emits `control.session_state` to connected clients (B106). Web hooks and the
      // worker's outbox delivery are later lanes.
      relay: {
        notify: (sid, state) =>
          redis.pubsub
            .publish(RELAY_CONTROL_CHANNEL, JSON.stringify({ kind: 'session_state', sid, state }))
            .then(() => undefined),
      },
      events: { publish: () => Promise.resolve() },
      cursorKeys: config.pagination.signingKeys,
      clock,
      logger,
      metrics,
    });
    sessionRoutes = {
      service: sessionService,
      store: createSessionRouteStore(db as unknown as SessionRoutesDb),
      slots: createSessionSlotStore(view<SessionSlotDatabase>()),
      entitlements,
      tickets: tokens,
      issued: kv,
      hostNotifier: {
        hostChanged: (sid, host, code) =>
          redis.pubsub
            .publish(
              RELAY_CONTROL_CHANNEL,
              JSON.stringify({ kind: 'host_changed', sid, host, code }),
            )
            .then(() => undefined),
      },
      relays: regions,
      cursorKeys: config.pagination.signingKeys,
      clock,
      logger,
      metrics,
    };
  }

  const data = createData({
    config,
    db,
    redis,
    logger,
    metrics,
    clock,
    audit,
    entitlementService,
    counters,
    quota,
  });

  const collab = createCollab({
    config,
    db,
    redis,
    logger,
    metrics,
    clock,
    audit,
    tokens,
    entitlementService,
    entitlements,
    sessionRoutes,
    mailer,
    email: emailService,
    ...(deps.purgeQueue === undefined ? {} : { purgeQueue: deps.purgeQueue }),
  });

  const billing = createBilling({
    config,
    db: db as unknown as Kysely<unknown>,
    entitlementService,
    logger,
    metrics,
    clock,
    ...(deps.stripeEventQueue === undefined ? {} : { eventQueue: deps.stripeEventQueue }),
  });

  const accountStore = createAccountLifecycleStore(view<LifecycleDb>());
  const accountBlobs =
    config.objectStore === null
      ? null
      : exportBlobStoreFrom(createS3ObjectStore(config.objectStore, { clock }));
  const accountEmitter = createAuditEmitter({
    db: view<CoreDatabase>() as unknown as AuditDb,
    actions: ACCOUNT_LIFECYCLE_ACTIONS,
    logger,
    metrics,
    clock,
  });
  const accounts: AccountLifecycle = {
    store: accountStore,
    blobs: accountBlobs,
    emitter: accountEmitter,
    service: new AccountLifecycleService({
      store: accountStore,
      emitter: accountEmitter,
      tokens,
      jobs: deps.accountJobs ?? {
        enqueueExport: () => Promise.resolve(),
        schedulePurge: () => Promise.resolve(),
        cancelPurge: () => Promise.resolve(),
      },
      blobs: accountBlobs ?? {
        presignGet: () => {
          throw new Error('no object store is configured');
        },
      },
      clock,
      logger,
      metrics,
    }),
  };

  return {
    ...deps,
    accounts,
    // the guarded logger replaces deps.logger for everything built from this context (B101)
    logger,
    metrics,
    billing,
    rbac,
    audit,
    sessionRoutes,
    sessionService,
    collab,
    data,
    counters,
    quota,
    entitlements,
    entitlementService,
    tokens,
    sessions,
    deviceGrants,
    authorizer,
    users,
    magicLink,
    deviceReturnTo,
    me,
    devices,
    readiness,
    statusFeed,
  };
}
