/**
 * Backpressure (B046): the 2 MiB outbound limit per connection (`sys.slow_down`, then 4429),
 * droppable frames dropped first, and the node-wide buffer guard. The relay module is `module.ts`
 * (order 55).
 */
export {
  backpressureEnvSchema,
  DEFAULT_NODE_BUFFER_MAX,
  DEFAULT_OUT_BUF_BYTES,
  DEFAULT_OUT_BUF_SOFT_BYTES,
  DEFAULT_SLOW_GRACE_MS,
  loadBackpressureConfig,
  type BackpressureConfig,
} from './config.js';
export {
  BACKPRESSURE_DETAILS,
  BUFFER_BUCKETS_BYTES,
  CLOSE_JITTER_MS,
  createBackpressure,
  NODE_GUARD_TARGET,
  SLOW_DOWN_EVERY_MS,
  SLOW_DOWN_FOR_MS,
  SWEEP_MS,
  type BackpressureController,
  type BackpressureDeps,
  type BackpressureTimer,
} from './controller.js';
export { BACKPRESSURE_ORDER, createBackpressureModule } from './module.js';
