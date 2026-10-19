/**
 * `pnpm tombstones:apply [--dry-run]` (after restoring a backup): deletes again the workspaces that were
 * purged after the backup was taken, using the tombstone log in the object store. Reads the same
 * configuration as the worker (DATABASE_URL, REDIS_URL, OBJECT_STORE_*). Prints ids and counts only.
 *
 * Exit codes: 0 done (or nothing to do); 1 failed; 2 no object store configured.
 */
import { ConfigError, createLogger, createRedis, keyPrefixFor } from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import { processWorkspacePurge } from '@centcom/worker';
import { loadApiConfig } from '../src/config.js';
import { createContext, type ApiDatabase } from '../src/context.js';
import { createJobServices } from '../src/jobs.js';
import { applyTombstones } from '../src/modules/tombstones/index.js';

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  let config;
  try {
    config = loadApiConfig();
  } catch (err) {
    process.stderr.write(
      `${err instanceof ConfigError ? err.message : 'the configuration could not be read'}\n`,
    );
    return 1;
  }
  if (config.objectStore === null) {
    process.stderr.write(
      'no object store is configured (OBJECT_STORE_*): there is no tombstone log to read\n',
    );
    return 2;
  }
  const logger = createLogger({
    level: 'warn',
    service: 'tombstones',
    version: '0.0.0',
    env: config.base.nodeEnv,
  });
  const db = createDb<ApiDatabase>({ url: config.base.databaseUrl.reveal(), poolMax: 2 });
  const redis = createRedis({
    url: config.base.redisUrl,
    keyPrefix: keyPrefixFor(config.base.nodeEnv),
    logger,
  });
  try {
    const ctx = createContext({ config, db, redis, logger });
    const jobs = createJobServices(ctx);
    if (jobs.tombstones === null) return 2;
    const report = await applyTombstones({
      db: db as never,
      log: jobs.tombstones,
      dryRun,
      logger,
      purge: (workspaceId) =>
        processWorkspacePurge(
          { id: `tombstone-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 },
          { hooks: jobs.hooks, store: jobs.workspaces, events: redis.pubsub, logger },
        ),
    });
    process.stdout.write(
      `${dryRun ? 'dry run: ' : ''}${report.tombstones} tombstones, ${report.purged.length} purged, ${report.wouldPurge.length} would be purged, ${report.absent} not in the database, ${report.unreadable} unreadable\n`,
    );
    for (const id of [...report.purged, ...report.wouldPurge]) process.stdout.write(`${id}\n`);
    return 0;
  } finally {
    await Promise.allSettled([closeDb(db), redis.close()]);
  }
}

process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.name : 'failed'}\n`);
  return 1;
});
