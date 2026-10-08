/**
 * The relay process (B037): reads the configuration (B004's base keys and RELAY_*), connects
 * Redis and Postgres, starts the relay, and shuts it down on SIGTERM or SIGINT.
 *
 * Exit codes: 0 after a shutdown (graceful or forced at the drain deadline), and for a signal that
 * arrives during startup (nothing is served then); 1 for bad configuration, a module that fails to
 * register (logged with its name), or a port already in use.
 *
 * Owns: wiring and the process. Must not: hold logic a test cannot reach (it lives in the
 * modules it calls).
 */
import { baseConfig, createLogger, createRedis, keyPrefixFor, type Logger } from '@centcom/core';
import { closeDb, createDb, healthCheck, type CoreDatabase } from '@centcom/db';
import { buildInfo } from './build-info.js';
import { loadRelayConfig } from './config.js';
import { dependencyProbe } from './health.js';
import { ModuleError } from './modules.js';
import { startRelay } from './server.js';
import { createShutdown, onShutdownSignals } from './shutdown.js';

/** After the work is done, the process is given this long to flush its logs, then exits. */
const EXIT_GRACE_MS = 2_000;
/** Longest wait for the Redis and Postgres clients to close. */
const RELEASE_TIMEOUT_MS = 3_000;

function startFailed(logger: Logger, err: unknown, port: number): void {
  if (err instanceof ModuleError) {
    logger.error({ module: err.module }, 'relay.start_failed');
  } else if ((err as { code?: unknown } | null)?.code === 'EADDRINUSE') {
    logger.error({ port }, 'relay.port_in_use');
  } else {
    logger.error({ error: err instanceof Error ? err.name : typeof err }, 'relay.start_failed');
  }
}

async function main(): Promise<number> {
  const base = baseConfig(process.env);
  const config = loadRelayConfig(process.env);
  const build = buildInfo();
  const logger = createLogger({
    level: base.logLevel,
    service: base.serviceName,
    version: build.version,
    env: base.nodeEnv,
  });

  const abort = new AbortController();
  let signalled: (signal: string) => void = () => undefined;
  const signal = new Promise<string>((resolve) => (signalled = resolve));
  onShutdownSignals(process, (name) => {
    abort.abort();
    signalled(name);
  });

  logger.info(
    { version: build.version, contract_version: build.contract_version },
    'relay.starting',
  );

  const redis = createRedis({ url: base.redisUrl, keyPrefix: keyPrefixFor(base.nodeEnv), logger });
  const db = createDb<CoreDatabase>({ url: base.databaseUrl.reveal(), applicationName: 'relay' });
  // Closing clients of a dependency that never answered must not keep the process alive.
  const release = (): Promise<void> =>
    Promise.race([
      Promise.all([redis.close().catch(() => undefined), closeDb(db).catch(() => undefined)]).then(
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, RELEASE_TIMEOUT_MS).unref()),
    ]);

  let running: Awaited<ReturnType<typeof startRelay>>;
  try {
    running = await startRelay({
      config,
      host: base.host,
      logger,
      redis,
      db,
      probe: dependencyProbe({ redis, db: () => healthCheck(db) }),
      build,
      signal: abort.signal,
    });
  } catch (err) {
    startFailed(logger, err, config.port);
    await release();
    return 1;
  }
  if (running === null) {
    logger.info({}, 'relay.start_aborted');
    await release();
    return 0;
  }

  const shutdown = createShutdown({
    server: running.server,
    registry: running.registry,
    drainMs: config.shutdownDrainMs,
    steps: running.shutdownSteps,
    logger,
  });
  logger.info({ signal: await signal }, 'relay.signal');
  const code = await shutdown();
  running.readiness.stop();
  await release();
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  },
  (err: unknown) => {
    // Configuration errors list the bad keys, never their values.
    console.error(err instanceof Error ? err.message : 'relay failed to start');
    process.exit(1);
  },
);
