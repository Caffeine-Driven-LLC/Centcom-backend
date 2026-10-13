/**
 * The API service's entrypoint (B102): reads the configuration once, opens Postgres and Redis,
 * builds the app (`buildApp`), listens, and on SIGTERM or SIGINT stops accepting connections,
 * lets requests in flight finish (up to 30 s) and closes the pools.
 *
 * Owns: the process: environment, signals, exit codes. Must not: listen before the configuration
 * is valid and the signing keys are loaded, print a configuration value, or hold routes (that is
 * `app.ts`).
 *
 * Exit codes: 0 after a clean shutdown; 1 for invalid configuration, backends that stay
 * unreachable, or a shutdown that did not finish in time.
 */
import {
  ConfigError,
  createLogger,
  createRedis,
  keyPrefixFor,
  type Logger,
  type RedisBackend,
} from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createWorkspacePurgeQueue } from '@centcom/worker';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { runWorker } from './worker.js';
import { loadApiConfig } from './config.js';
import type { ApiDatabase } from './context.js';
import { mailpitMailer } from './modules/auth/magic-link/dev-mailer.js';
import { serve } from './serve.js';

/** Tries at reaching Postgres and Redis before giving up, and the wait between them. */
const CONNECT_TRIES = 3;
const CONNECT_WAIT_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes one line to stderr before the logger exists; never a value. */
const fail = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

async function reachable(
  db: Kysely<ApiDatabase>,
  redis: RedisBackend,
  logger: Logger,
): Promise<boolean> {
  for (let attempt = 1; attempt <= CONNECT_TRIES; attempt += 1) {
    try {
      await sql`select 1`.execute(db);
      await redis.ping();
      return true;
    } catch {
      logger.warn({ attempt, of: CONNECT_TRIES }, 'api.backends_unreachable');
      if (attempt < CONNECT_TRIES) await sleep(CONNECT_WAIT_MS);
    }
  }
  return false;
}

async function main(): Promise<number> {
  if (process.argv.includes('--worker')) return runWorker(process.env); // `pnpm dev:worker`
  let config;
  try {
    config = loadApiConfig(process.env);
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : 'The configuration could not be read.');
    return 1;
  }
  const { base } = config;
  const logger = createLogger({
    level: base.logLevel,
    service: base.serviceName,
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
    env: base.nodeEnv,
  });
  const db = createDb<ApiDatabase>({
    url: base.databaseUrl.reveal(),
    applicationName: base.serviceName,
    logger,
  });
  const redis = createRedis({
    url: base.redisUrl,
    keyPrefix: keyPrefixFor(base.nodeEnv),
    logger,
  });
  const closeBackends = async (): Promise<void> => {
    await Promise.allSettled([closeDb(db), redis.close()]);
  };

  if (!(await reachable(db, redis, logger))) {
    logger.error({}, 'api.start_failed');
    await closeBackends();
    return 1;
  }

  const mailer =
    config.mailpitUrl !== null && config.magicLink !== null
      ? mailpitMailer({
          url: config.mailpitUrl,
          from: 'Centcom <no-reply@centcom.test>',
          ttlS: config.magicLink.ttlS,
        })
      : undefined;
  // A deleted workspace is purged by the worker through this queue (BullMQ wants its own connection).
  const queueConnection = new Redis(base.redisUrl.reveal(), { maxRetriesPerRequest: null });
  queueConnection.on('error', () => undefined); // a down Redis is the readiness probe's business
  const purgeQueue = createWorkspacePurgeQueue({ connection: queueConnection });
  const closeQueues = async (): Promise<void> => {
    await Promise.allSettled([purgeQueue.close(), queueConnection.quit()]);
  };
  const app = await buildApp({
    config,
    db,
    redis,
    logger,
    purgeQueue,
    ...(mailer === undefined ? {} : { mailer }),
  });

  const server = await serve(app, {
    host: base.host,
    port: base.port,
    logger,
    closeBackends: async () => {
      await closeQueues();
      await closeBackends();
    },
  });
  return new Promise<number>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => void server.stop(signal).then(resolve));
    }
  });
}

main().then(
  (code) => {
    // Pending log writes flush on their own; a connection that will not close cannot hold the exit.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2_000).unref();
  },
  (err: unknown) => {
    fail(`The API stopped: ${err instanceof Error ? err.name : 'unknown error'}.`);
    process.exitCode = 1;
  },
);
