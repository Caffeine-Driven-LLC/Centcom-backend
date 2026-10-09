/**
 * Backpressure configuration (B046, CT-WS-ENVELOPE "Limits": 2 MiB outbound buffer per
 * connection):
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELAY_OUT_BUF_BYTES` | 2 097 152 | A connection's outbound buffer limit (hard watermark). |
 * | `RELAY_OUT_BUF_SOFT_BYTES` | 1 048 576 | Above it droppable frames are dropped; below it a slow consumer has recovered. |
 * | `RELAY_SLOW_GRACE_MS` | 5 000 | A connection over the limit must get back under the soft mark within this, or it is closed 4429. |
 * | `RELAY_NODE_BUFFER_MAX` | 1 073 741 824 | Every connection's buffered bytes together; above it the largest are closed and the node is not ready. |
 *
 * Owns: reading and checking these keys. Must not: allow a soft mark at or above the hard one.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** Card defaults. */
export const DEFAULT_OUT_BUF_BYTES = 2_097_152;
export const DEFAULT_OUT_BUF_SOFT_BYTES = 1_048_576;
export const DEFAULT_SLOW_GRACE_MS = 5_000;
export const DEFAULT_NODE_BUFFER_MAX = 1_073_741_824;

/** The environment keys of the backpressure module. */
export const backpressureEnvSchema = z
  .object({
    RELAY_OUT_BUF_BYTES: envInt({ min: 65_536, max: 268_435_456 })
      .default(DEFAULT_OUT_BUF_BYTES)
      .meta({ description: "A connection's outbound buffer limit, in bytes.", example: '2097152' }),
    RELAY_OUT_BUF_SOFT_BYTES: envInt({ min: 16_384, max: 268_435_456 })
      .default(DEFAULT_OUT_BUF_SOFT_BYTES)
      .meta({
        description:
          'Above this many buffered bytes droppable frames are dropped (presence, cursors).',
        example: '1048576',
      }),
    RELAY_SLOW_GRACE_MS: envInt({ min: 100, max: 600_000 }).default(DEFAULT_SLOW_GRACE_MS).meta({
      description: 'Milliseconds a connection over the limit has to drain under the soft mark.',
      example: '5000',
    }),
    RELAY_NODE_BUFFER_MAX: envInt({ min: 1_048_576, max: 68_719_476_736 })
      .default(DEFAULT_NODE_BUFFER_MAX)
      .meta({
        description: 'All connections’ buffered bytes together, at most.',
        example: '1073741824',
      }),
  })
  .refine((v) => v.RELAY_OUT_BUF_SOFT_BYTES < v.RELAY_OUT_BUF_BYTES, {
    message: 'RELAY_OUT_BUF_SOFT_BYTES must be below RELAY_OUT_BUF_BYTES',
    path: ['RELAY_OUT_BUF_SOFT_BYTES'],
  });

/** Checked backpressure settings. */
export interface BackpressureConfig {
  hardBytes: number;
  softBytes: number;
  graceMs: number;
  nodeMaxBytes: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadBackpressureConfig(env?: Env): BackpressureConfig {
  const v = defineConfig(backpressureEnvSchema, env);
  return {
    hardBytes: v.RELAY_OUT_BUF_BYTES,
    softBytes: v.RELAY_OUT_BUF_SOFT_BYTES,
    graceMs: v.RELAY_SLOW_GRACE_MS,
    nodeMaxBytes: v.RELAY_NODE_BUFFER_MAX,
  };
}
