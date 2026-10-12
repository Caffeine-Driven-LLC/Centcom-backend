/**
 * Listening and stopping (B102): `serve` starts an app on a port and returns a handle whose
 * `stop()` refuses new connections, lets requests in flight finish (up to `graceMs`), runs the
 * `closeBackends` callback and resolves with the exit code. `main.ts` calls it with the process's
 * signals; the tests call it with their own.
 *
 * Owns: the order of shutdown and its time limit. Must not: read the environment or exit the
 * process (the caller decides what to do with the code).
 */
import type { Logger } from '@centcom/core';
import type { FastifyInstance } from 'fastify';

/** How long requests in flight get after a stop signal. */
export const SHUTDOWN_GRACE_MS = 30_000;

/** Options for `serve`. */
export interface ServeOptions {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  logger: Logger;
  /** Closes the pools; runs after the server has drained. */
  closeBackends(): Promise<void>;
  /** Default SHUTDOWN_GRACE_MS. */
  graceMs?: number;
}

/** A running server. */
export interface Server {
  /** The address it listens on. */
  address: string;
  /** Stops once (later calls get the same answer): 0 after a clean stop, 1 otherwise. */
  stop(reason: string): Promise<number>;
}

export async function serve(app: FastifyInstance, options: ServeOptions): Promise<Server> {
  const { logger } = options;
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const address = await app.listen({ host: options.host, port: options.port });
  logger.info({ host: options.host, port: options.port }, 'api.listening');

  let stopping: Promise<number> | undefined;
  return {
    address,
    stop(reason) {
      stopping ??= (async () => {
        logger.info({ reason }, 'api.stopping');
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<number>((resolve) => {
          timer = setTimeout(() => {
            logger.error({}, 'api.shutdown_timeout');
            resolve(1);
          }, graceMs);
        });
        // A connection that finishes its request while draining would otherwise idle on keep-alive
        // (72 s) and hold `close()` up: close the idle ones as they appear.
        const sweep = setInterval(() => app.server.closeIdleConnections(), 100);
        const clean = (async () => {
          // `close()` stops accepting and waits for requests in flight.
          await app.close();
          await options.closeBackends();
          return 0;
        })().catch(() => 1);
        try {
          return await Promise.race([clean, late]);
        } finally {
          clearTimeout(timer);
          clearInterval(sweep);
        }
      })();
      return stopping;
    },
  };
}
