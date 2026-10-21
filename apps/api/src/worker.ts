/**
 * The worker process (B109): reads the API's configuration, opens Postgres and Redis, builds the
 * API's services and runs the jobs over them: the usage aggregation (fills the monthly counters
 * the entitlement check reads), the session and invite expiry sweeps and the workspace purge.
 * Stops on SIGTERM or SIGINT (workers finish the job in hand).
 *
 * Exit codes: 0 after a shutdown, 1 for bad configuration or unreachable Postgres or Redis.
 *
 * Owns: the process's body (`main.ts` starts it with `--worker`). Must not: read the environment
 * itself, or hold logic a test cannot reach (it is in `jobs.ts` and the jobs).
 */
import {
  ConfigError,
  createEmailProvider,
  createLogger,
  createRedis,
  keyPrefixFor,
  type Env,
  type Logger,
} from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import {
  createAccountExportQueue,
  createAccountPurgeQueue,
  createWorkspacePurgeQueue,
  scheduleAccountExportSweep,
  scheduleAccountPurgeSweep,
  startAccountExportWorker,
  startAccountPurgeWorker,
  createInviteExpiryQueue,
  createSessionExpiryQueue,
  createStripeEventDlq,
  createStripeEventQueue,
  createUsageAggregateQueue,
  scheduleInviteExpiry,
  scheduleSessionExpiry,
  scheduleStripeEventSweep,
  scheduleUsageAggregate,
  startEmailWorker,
  startInviteExpiryWorker,
  startSessionExpiryWorker,
  startStripeEventWorker,
  startUsageAggregateWorker,
  startWorkspacePurgeWorker,
} from '@centcom/worker';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { loadApiConfig } from './config.js';
import { createContext, type ApiDatabase } from './context.js';
import { createJobServices } from './jobs.js';

const CONNECT_TRIES = 3;
const CONNECT_WAIT_MS = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs the worker until a stop signal; `env` is the process environment (read by `main.ts`). */
export async function runWorker(env: Env): Promise<number> {
  let config;
  try {
    config = loadApiConfig(env);
  } catch (err) {
    process.stderr.write(
      `${err instanceof ConfigError ? err.message : 'The configuration could not be read.'}\n`,
    );
    return 1;
  }
  const { base } = config;
  const logger: Logger = createLogger({
    level: base.logLevel,
    service: 'worker',
    version: env['SERVICE_VERSION'] ?? '0.0.0',
    env: base.nodeEnv,
  });
  const db = createDb<ApiDatabase>({
    url: base.databaseUrl.reveal(),
    applicationName: 'worker',
    logger,
  });
  const redis = createRedis({ url: base.redisUrl, keyPrefix: keyPrefixFor(base.nodeEnv), logger });
  const connection = new Redis(base.redisUrl.reveal(), { maxRetriesPerRequest: null });
  connection.on('error', () => undefined);

  let reachable = false;
  for (let attempt = 1; attempt <= CONNECT_TRIES && !reachable; attempt += 1) {
    try {
      await sql`select 1`.execute(db);
      await redis.ping();
      reachable = true;
    } catch {
      logger.warn({ attempt, of: CONNECT_TRIES }, 'worker.backends_unreachable');
      if (attempt < CONNECT_TRIES) await sleep(CONNECT_WAIT_MS);
    }
  }
  const release = async (): Promise<void> => {
    await Promise.allSettled([connection.quit(), closeDb(db), redis.close()]);
  };
  if (!reachable) {
    logger.error({}, 'worker.start_failed');
    await release();
    return 1;
  }

  // A workspace the account purge deletes is purged by this process's workspace-purge worker, so the
  // services built here queue to it (without a queue the soft delete would only be logged).
  const purgeQueue = createWorkspacePurgeQueue({ connection });
  const ctx = createContext({ config, db, redis, logger, purgeQueue });
  const jobs = createJobServices(ctx);
  const common = { logger, metrics: ctx.metrics };
  const closers: (() => Promise<unknown>)[] = [];

  const usageQueue = createUsageAggregateQueue({ connection });
  await scheduleUsageAggregate(usageQueue);
  const usage = startUsageAggregateWorker({
    connection,
    run: (now) => jobs.usage.run(now),
    ...common,
  });
  closers.push(
    () => usage.close(),
    () => usageQueue.close(),
  );

  const inviteQueue = createInviteExpiryQueue({ connection });
  await scheduleInviteExpiry(inviteQueue);
  const invites = startInviteExpiryWorker({ connection, store: jobs.invites, ...common });
  closers.push(
    () => invites.close(),
    () => inviteQueue.close(),
  );

  if (jobs.sessions !== null) {
    const sessionQueue = createSessionExpiryQueue({ connection });
    await scheduleSessionExpiry(sessionQueue);
    const sessions = startSessionExpiryWorker({
      connection,
      sessions: jobs.sessions,
      ...(jobs.shareLinks === null ? {} : { shareLinks: jobs.shareLinks }),
      ...common,
    });
    closers.push(
      () => sessions.close(),
      () => sessionQueue.close(),
    );
  }

  closers.push(() => purgeQueue.close());

  // Account deletion (B026): the purge at the end of the 30-day grace (an hourly sweep also queues due
  // ones) and, with an object store, the data exports.
  const accountPurgeQueue = createAccountPurgeQueue({ connection });
  await scheduleAccountPurgeSweep(accountPurgeQueue);
  const accountPurge = startAccountPurgeWorker({
    connection,
    queue: accountPurgeQueue,
    purge: (userId) => jobs.accounts.purge(userId),
    due: (now, limit) => jobs.accounts.due(now, limit),
    ...common,
  });
  closers.push(
    () => accountPurge.close(),
    () => accountPurgeQueue.close(),
  );
  const exportRunner = jobs.accounts.exports;
  if (exportRunner !== null) {
    const accountExportQueue = createAccountExportQueue({ connection });
    await scheduleAccountExportSweep(accountExportQueue);
    const accountExport = startAccountExportWorker({
      connection,
      queue: accountExportQueue,
      run: (exportId, opts) => exportRunner.run(exportId, opts),
      sweep: (now) => exportRunner.sweep(now),
      ...common,
    });
    closers.push(
      () => accountExport.close(),
      () => accountExportQueue.close(),
    );
  }

  const purge = startWorkspacePurgeWorker({
    connection,
    hooks: jobs.hooks,
    store: jobs.workspaces,
    events: redis.pubsub,
    ...common,
  });
  closers.push(() => purge.close());

  // Stripe webhook events: stored by the API, processed here (subscriptions reach entitlements only
  // through this job). The billing outbox (B081 webhooks, B063 notices) is not published yet.
  if (ctx.billing !== null) {
    const { processor, events } = ctx.billing;
    const stripeQueue = createStripeEventQueue({ connection });
    const dlq = createStripeEventDlq({ connection });
    await scheduleStripeEventSweep(stripeQueue);
    const stripeWorker = startStripeEventWorker({
      connection,
      queue: stripeQueue,
      dlq,
      process: (eventId, opts) => processor.process(eventId, opts),
      waiting: (before, limit) => events.waiting(before, limit),
      oldestWaiting: () => events.oldestWaiting(),
      publish: () => Promise.resolve(0),
      ...common,
    });
    closers.push(
      () => stripeWorker.close(),
      () => stripeQueue.close(),
      () => dlq.close(),
    );
  }

  // Delivers the sign-in and invite mail the API queued (only when a real provider is chosen).
  if (config.email !== null) {
    const mail = startEmailWorker({
      connection,
      provider: createEmailProvider(config.email, logger),
      kv: redis.kv,
      timeoutMs: config.email.timeoutMs,
      ...common,
    });
    closers.push(() => mail.close());
  }

  logger.info(
    {
      jobs: [
        'usage.aggregate',
        'invite-expiry',
        'session-expiry',
        'workspace-purge',
        'account-purge',
        ...(exportRunner === null ? [] : ['account-export']),
      ],
      email: config.email?.provider ?? 'off',
      billing: ctx.billing === null ? 'off' : 'stripe',
    },
    'worker.started',
  );
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve());
  });
  logger.info({}, 'worker.stopping');
  await Promise.allSettled(closers.map((close) => close()));
  await ctx.audit.flush(2_000).catch(() => undefined);
  await release();
  return 0;
}
