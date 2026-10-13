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
  createLogger,
  createRedis,
  keyPrefixFor,
  type Env,
  type Logger,
} from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import {
  createInviteExpiryQueue,
  createSessionExpiryQueue,
  createUsageAggregateQueue,
  scheduleInviteExpiry,
  scheduleSessionExpiry,
  scheduleUsageAggregate,
  startInviteExpiryWorker,
  startSessionExpiryWorker,
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

  const ctx = createContext({ config, db, redis, logger });
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

  const purge = startWorkspacePurgeWorker({
    connection,
    hooks: jobs.hooks,
    store: jobs.workspaces,
    events: redis.pubsub,
    ...common,
  });
  closers.push(() => purge.close());

  logger.info(
    { jobs: ['usage.aggregate', 'invite-expiry', 'session-expiry', 'workspace-purge'] },
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
