/**
 * The backpressure relay module (B046, order 55): every accepted connection gets the controller as
 * its outbound policy (B044's `ConnectionSender` consults it for each frame), `/readyz` gets a
 * `buffers` check (failing while the node's buffers are over RELAY_NODE_BUFFER_MAX, so new
 * connections are refused), and `ctx.backpressure` offers `whenDrained` to B042's replay. Settings
 * come from RELAY_OUT_BUF_BYTES, RELAY_OUT_BUF_SOFT_BYTES, RELAY_SLOW_GRACE_MS and
 * RELAY_NODE_BUFFER_MAX (`config.ts`). It registers no pipeline stage.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { Env } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { loadBackpressureConfig } from './config.js';
import { createBackpressure } from './controller.js';

/** The module's registration order: after sequencing (40), resume (45) and fan-out (50). */
export const BACKPRESSURE_ORDER = 55;

/** The module, reading its settings from `env` (default: the process environment). */
export function createBackpressureModule(env?: Env): RelayModule {
  return {
    name: 'backpressure',
    order: BACKPRESSURE_ORDER,
    register(ctx) {
      const controller = createBackpressure({
        config: loadBackpressureConfig(env),
        clock: ctx.clock,
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.onConnection((connection) => controller.attach(connection));
      ctx.addReadinessCheck('buffers', () => !controller.overloaded());
      ctx.backpressure = controller;
      ctx.onShutdown(() => {
        controller.stop();
        return Promise.resolve();
      });
      return undefined;
    },
  };
}

const relayModule: RelayModule = createBackpressureModule();

export default relayModule;
