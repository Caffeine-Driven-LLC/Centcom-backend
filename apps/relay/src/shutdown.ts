/**
 * Graceful shutdown (B037, CT-WS-ENVELOPE close 1001). On SIGTERM or SIGINT:
 *
 * 1. `/readyz` turns 503 and new upgrades get 503, so the load balancer stops routing here;
 * 2. every open connection is sent `sys.bye` (`reason: "server_restart"`) and closed 1001, each
 *    at a random moment within 5 s, so clients do not all reconnect at once;
 * 3. once every connection is gone, or at RELAY_SHUTDOWN_DRAIN_MS, whichever comes first, those
 *    still open are cut (`shutdown.forced` with the count), the modules' shutdown steps run, and
 *    the HTTP server closes. The exit code is 0 either way.
 *
 * A second signal changes nothing: the shutdown already under way finishes.
 *
 * Owns: the order of shutdown. Must not: close every connection at the same instant.
 */
import type { Logger } from '@centcom/core';
import { CloseCode } from './close-codes.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { sysBye, type RelayServer } from './server.js';

/** The window `sys.bye` and close 1001 are spread over. */
export const SHUTDOWN_JITTER_MS = 5_000;
/** The `sys.bye` reason of a restart. */
export const SHUTDOWN_REASON = 'server_restart';

/** Options for createShutdown. */
export interface ShutdownOptions {
  server: Pick<RelayServer, 'beginDrain' | 'connections' | 'close'>;
  registry: Pick<ConnectionRegistry, 'size' | 'whenEmpty'>;
  /** RELAY_SHUTDOWN_DRAIN_MS. */
  drainMs: number;
  /** Default SHUTDOWN_JITTER_MS. */
  jitterMs?: number;
  /** A number in [0, 1); default Math.random. */
  random?: () => number;
  /** The modules' steps, run after the connections are gone. */
  steps?: readonly (() => Promise<void>)[];
  logger: Logger;
}

/** Shuts the relay down (once, however often it is called); resolves the exit code. */
export type Shutdown = () => Promise<number>;

export function createShutdown(options: ShutdownOptions): Shutdown {
  const jitterMs = options.jitterMs ?? SHUTDOWN_JITTER_MS;
  const random = options.random ?? Math.random;
  let running: Promise<number> | undefined;

  const run = async (): Promise<number> => {
    const { server, registry, logger } = options;
    server.beginDrain();
    logger.info({ connections: registry.size, drain_ms: options.drainMs }, 'shutdown.started');
    const pending = new Set<NodeJS.Timeout>();
    for (const connection of server.connections()) {
      const timer = setTimeout(
        () => {
          pending.delete(timer);
          connection.send(sysBye(SHUTDOWN_REASON));
          connection.close(CloseCode.GoingAway, SHUTDOWN_REASON);
        },
        Math.floor(random() * jitterMs),
      );
      pending.add(timer);
    }
    let deadline: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      registry.whenEmpty().then(() => 'drained' as const),
      new Promise<'deadline'>((resolve) => {
        deadline = setTimeout(() => resolve('deadline'), options.drainMs);
      }),
    ]);
    clearTimeout(deadline);
    for (const timer of pending) clearTimeout(timer);
    if (outcome === 'deadline') {
      const open = server.connections();
      for (const connection of open) connection.terminate();
      logger.warn({ count: open.length }, 'shutdown.forced');
    }
    for (const step of options.steps ?? []) {
      try {
        await step();
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.name : typeof err },
          'shutdown.step_failed',
        );
      }
    }
    await server.close();
    logger.info({}, 'shutdown.complete');
    return 0;
  };

  return () => (running ??= run());
}

/** What signals arrive on (`process`). */
export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** Calls `onSignal` on SIGTERM and SIGINT. */
export function onShutdownSignals(source: SignalSource, onSignal: (signal: string) => void): void {
  source.on('SIGTERM', () => onSignal('SIGTERM'));
  source.on('SIGINT', () => onSignal('SIGINT'));
}
